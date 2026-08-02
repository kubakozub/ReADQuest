# ReADQuest

Lokalne rozszerzenie MV3 do oznaczania i blokowania ruchu według zakresu programu
bug bounty. Robi to, co robiłeś w Requestly, tylko bez chmury i z wbudowaną
weryfikacją, bo główna lekcja z poprzedniego raportu brzmiała: *„Active" w
interfejsie nie znaczy, że reguła działa*.

Trzy różnice względem Requestly, które są tu istotne:

1. **Nic nie wychodzi na zewnątrz.** Reguły to plik na dysku. Ograniczenie „zero
   nagłówków `Cookie` i `Authorization`, bo reguły idą do chmury" przestaje
   obowiązywać z powodu technicznego — zostaje wyłącznie jako Twoja decyzja.
2. **Weryfikacja jest częścią narzędzia, nie procedurą obok niego.** Po każdej
   zmianie rozszerzenie odczytuje z silnika Chrome, co naprawdę zostało
   zainstalowane, i porównuje z tym, co miało być. Martwa reguła jest widoczna
   od razu jako czerwony błąd, a nie jako komunikat w konsoli, na który trzeba
   wpaść.
3. **Tester dopasowań nie wysyła żądań.** Używa `testMatchOutcome`, czyli pyta
   silnik „co byś zrobił z tym URL-em", bez ruchu sieciowego. Punkt 3 protokołu
   (brak wycieku na hoście spoza scope) da się przez to sprawdzić bez wchodzenia
   na host spoza scope.

---

## Instalacja

```bash
node tools/sync-manifest.mjs
```

Potem `chrome://extensions` → tryb dewelopera → **Załaduj rozpakowane** → wskaż
katalog `ReADQuest`. Musi być rozpakowane: log trafień (`onRuleMatchedDebug`)
i tester (`testMatchOutcome`) są w Chrome dostępne wyłącznie dla rozszerzeń
ładowanych lokalnie.

Sprawdzenie bez Chrome, przydatne po każdej edycji zakresu:

```bash
node tools/selftest.mjs
```

Odtwarza logikę dopasowania DNR w Node i przepuszcza przez nią całą baterię
`verification` ze `scope.config.json` w **dwóch przebiegach**: w stanie
domyślnym rozszerzenia (ta sama stała `DEFAULT_TOGGLES`, której używa service
worker) oraz w stanie odstępstwa ze zdjętą blokadą produkcji. Drugi przebieg
dopuszcza wyłącznie jedną różnicę — przypadki `expect: "block"` stają się
`none`. Cokolwiek innego znaczy, że zdjęcie blokady rusza oznaczanie albo
wykluczenia, czego robić nie ma prawa.

---

## KROK 0 — odpowiedź

**Twoja hipoteza jest trafna: DNR ma pola dopasowania, które nie kompilują
regexa, i limit 2 KB ich nie dotyczy.**

| pole | czym jest | limit 2 KB |
|---|---|---|
| `regexFilter` | wyrażenie RE2 na pełnym URL-u | **tak** |
| `urlFilter` | wzorzec ze znakami `*`, `\|`, `\|\|`, `^` | nie |
| `requestDomains` | zwykła lista domen; dopasowuje domenę **i jej subdomeny** | nie |
| `excludedRequestDomains` | to samo, ale wyklucza | nie |

Czyli: jeżeli Requestly mapuje **Host / Matches (Wildcard)** na `requestDomains`
albo `urlFilter`, problem alternacji znika i lista hostów może zostać w jednej
regule. Jeżeli mapuje wszystko na `regexFilter` — trzeba rozbijać.

**Zamiast testu 2 KB zrób test, który daje odpowiedź wprost.** Test z v2 jest
pośredni: mówi „nie przekroczyło limitu", a nie „nie użyto regexa". Dwa warunki
mogą się zmieścić w 2 KB i nadal być regexem, więc brak błędu niczego nie
dowodzi. Bezpośrednio:

1. `chrome://extensions` → tryb dewelopera włączony.
2. Karta Requestly → link **service worker** → otwiera się DevTools.
3. W konsoli:

```js
await chrome.declarativeNetRequest.getDynamicRules()
```

To zwraca reguły tak, jak widzi je silnik. Patrzysz w `condition` każdej z nich:
jest tam `regexFilter` czy `requestDomains`/`urlFilter`. Żadnego zgadywania.
Warto dorzucić `getSessionRules()` i `getEnabledRulesets()`, bo Requestly może
używać obu ścieżek.

**W ReADQuest pytanie i tak jest bezprzedmiotowe**, bo kompilacją sterujesz Ty:

- `mode: "domainAndSubdomains"` → `requestDomains: [host]`, zero regexa;
- `mode: "exact"` → krótki zakotwiczony regex, 41 znaków w najdłuższym
  przypadku wobec limitu ~2000;
- każdy wygenerowany regex przechodzi przed instalacją przez
  `isRegexSupported()`, czyli natywny walidator RE2 Chrome — to jest ten sam
  warunek, który w Requestly objawiał się jako *„was skipped … 2KB memory
  limit"*, tylko sprawdzany zawczasu i widoczny w zakładce Diagnostyka.

**Jedna reguła na host mimo braku przymusu.** Rozbicie nie jest już wymuszone
limitem, ale zostaje — bo tylko wtedy log trafień i tester potrafią powiedzieć
*która* pozycja zakresu strzeliła. Przy limicie 5000 reguł dynamicznych 25 reguł
nie jest żadnym kosztem.

---

## Jak to jest zbudowane

```
scope.config.json      jedyne źródło prawdy: hosty, wykluczenia, blokady, testy
src/compile.js         config -> reguły DNR (czysta funkcja, bez chrome.*)
src/background.js      instalacja reguł, kontrola zdrowia, log, tester
src/popup.*            przełączniki + cztery zakładki
tools/sync-manifest.mjs  regeneruje host_permissions z configu
tools/selftest.mjs     offline'owa replika dopasowania DNR
```

Trzy tryby dopasowania hosta:

| `mode` | znaczenie | implementacja |
|---|---|---|
| `exact` | tylko ten host | `^https?://host(:\d+)?/` |
| `domainAndSubdomains` | host + subdomeny | `requestDomains: [host]` |
| `subdomains` | wyłącznie subdomeny, apex nie | `^https?://([^/:?#@]+\.)+host(:\d+)?/` |

`domainAndSubdomains` odpowiada dokładnie Twojemu regexowi z v1
(`^(.+\.)?domena\.tld$`) — apex jest objęty. Zapis `*.wpengine.io` w zakresie
programu bywa czytany jako „tylko subdomeny"; jeśli chcesz tę interpretację,
zmień `mode` na `subdomains`.

Priorytety: blok produkcji 300 > wykluczenie 200 > oznaczanie 10. Blok wygrywa
zawsze, także z wykluczeniem.

### Nagłówek

`navigator.userAgent` przeglądarki + spacja + `identity.marker`. UA nie jest
zaszyty na sztywno, więc nie zdezaktualizuje się po aktualizacji Chrome.
Podmieniany jest wyłącznie nagłówek HTTP — `navigator.userAgent` w JavaScripcie
strony pozostaje nietknięty, co ogranicza ryzyko rozjazdów w aplikacji.
Nadpisanie wartości: `identity.userAgentOverride` w configu.

---

## Protokół weryfikacji — gdzie co sprawdzasz

| krok protokołu | gdzie |
|---|---|
| 1. zero „was skipped" | zakładka **Diagnostyka** — zielony komunikat znaczy: każda reguła potwierdzona odczytem z silnika, żaden regex nieodrzucony, żadna reguła osierocona, `host_permissions` kompletne |
| 2. trafienie w cel | zakładka **Tester** (statycznie) + **Log trafień** i DevTools → Network podczas realnej sesji |
| 3. brak wycieku | zakładka **Tester** — bateria zawiera oba przypadki, na których wykładała się poprzednia reguła: domena w query stringu oraz domena jako prefiks (`allegrosandbox.pl.cokolwiek.tld`) |
| 4. blokada produkcji | zakładka **Tester** (przełącznik włączony domyślnie); potwierdzenie w Network przy realnym wejściu |

Zakładka **Reguły** pokazuje skompilowany JSON z przyciskiem kopiowania — to
jest eksport z Decyzji 5. Kopiuj dopiero, gdy Diagnostyka jest zielona,
a Tester świeci 24/24.

Rozszerzenie **nigdy nie inicjuje żądań samo z siebie**. Tester działa na
symulacji silnika, log jest pasywny. Ograniczenie „żadnych żądań poza tymi
z protokołu weryfikacji" jest spełnione konstrukcyjnie.

---

## Znane ograniczenia

- **`host_permissions` musi pokrywać hosty oznaczane.** Bez tego `modifyHeaders`
  nie ma prawa dodać nagłówka, choć reguła będzie wyglądać na aktywną — dokładnie
  ten rodzaj cichej awarii, który tu tępimy. Diagnostyka to wykrywa i mówi, co
  uruchomić. Efekt uboczny jest korzystny: lista originów w manifeście działa
  jako druga siatka bezpieczeństwa, bo nawet błędna reguła nie doda nagłówka
  hostowi, którego świadomie nie wpisałeś.
- **Podzasoby ładowane z hosta spoza scope.** Chrome wymaga dla `modifyHeaders`
  uprawnienia także do inicjatora żądania. Jeśli w logu widzisz, że podzasoby
  z hosta w scope nie dostają nagłówka, dopisz `"*://*/*"` do `host_permissions`
  — świadomie poszerzasz uprawnienia w zamian za pokrycie.
- **Blokada produkcji nie pokrywa pozycji „Other" w zakresie Allegro.** To jest
  siatka bezpieczeństwa dla wyliczonych domen, nie gwarancja. Szczegół
  w `NOTATKA.md`.
- Log trafień żyje w `storage.session` — znika po restarcie przeglądarki. Jeśli
  ma być dowodem w raporcie, skopiuj go przed zamknięciem.
- Testowane offline na symulatorze DNR (24/24). Uruchomienie w realnym Chrome
  jest po Twojej stronie — nie mam dostępu do Twojej przeglądarki.
