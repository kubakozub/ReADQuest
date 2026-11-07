# Notatka operacyjna: ReADQuest

Stan: konfiguracja gotowa, zweryfikowana offline. Kolumny „Chrome" czekają na
uruchomienie w Twojej przeglądarce.

---

## 1. Wynik KROK 0

**Hipoteza z v2 potwierdzona.** Limit 2 KB dotyczy wyłącznie `regexFilter`.
Pola `urlFilter`, `requestDomains` i `excludedRequestDomains` regexa nie
kompilują i limitowi nie podlegają. `requestDomains` dopasowuje domenę i jej
subdomeny, czyli dokładnie to, co robił regex `^(.+\.)?domena\.tld$` z v1.

Test 2 KB zaproponowany w v2 jest pośredni: brak błędu nie dowodzi, że
Requestly nie użyło regexa, tylko że regex się zmieścił. Test dający odpowiedź
wprost, w konsoli service workera Requestly (`chrome://extensions` → tryb
dewelopera → **service worker**):

```js
await chrome.declarativeNetRequest.getDynamicRules()
```

Widać w `condition`, którego pola narzędzie faktycznie użyło. **Do wykonania po
Twojej stronie**, jeśli chcesz zamknąć wątek Requestly; dla ReADQuest jest
bezprzedmiotowy, bo kompilacja jest nasza.

Architektura reszty: **jedna reguła na host**, mimo że limit już nie zmusza.
Powód jest inny niż w v2, bez rozbicia log trafień i tester nie potrafią
wskazać, która pozycja zakresu strzeliła. Koszt: 25 reguł wobec limitu 5000.

---

## 2. Co zostało ustawione

**Oznaczanie: WP Engine (14 reguł)**

Hosty dokładne, bez subdomen: `wpengine.com`, `my.wpengine.com`,
`payments.wpengine.com`, `getflywheel.com`, `makeshift.film`,
`studiopress.blog`, `torquemag.io`.

Domena + subdomeny: `advancedcustomfields.com`, `bettersearchreplace.com`,
`deliciousbrains.com`, `localwp.com`, `studiopress.com`, `wpengine.io`,
`wpesvc.net`.

**Oznaczanie: Allegro Sandbox (3 reguły)**

`allegro.pl.allegrosandbox.pl`, `allegro.sk.allegrosandbox.pl`,
`allegro.cz.allegrosandbox.pl`, każdy z subdomenami. Decyzja 3 wykonana:
wszystkie trzy rynki.

**Wartość nagłówka:** pełny UA przeglądarki odczytany w locie + ` TWOJ_ALIAS@intigriti.me`.
Bez zaszytego na sztywno stringa, więc nie zestarzeje się po aktualizacji Chrome.

**Wykluczenia twarde (4 reguły `allow`, priorytet 200)**

`app.getflywheel.com`, `velocitize.com`, `flywheelsites.com`, `nitropack.io`.
Te hosty nie są objęte żadną regułą oznaczającą, ale reguła `allow` stoi tam
dodatkowo: żeby przyszłe poszerzenie wildcarda nie objęło ich przez przypadek.

**Blokada produkcji (4 reguły, priorytet 300)**

`allegro.pl`, `allegro.sk`, `allegro.cz`, `allegrogroup.com`: każdy
z subdomenami, więc `*.allegro.pl` i pozostałe wildcardy z Decyzji 4 są pokryte.
Priorytet wyższy niż wykluczenia, więc blok wygrywa ze wszystkim.

---

## 3. Wyniki sprawdzeń

### Offline (`node tools/selftest.mjs`): wykonane, 24/24 w obu przebiegach

Symulator odtwarza semantykę `requestDomains` i `regexFilter`, i puszcza baterię
dwa razy: w stanie domyślnym rozszerzenia oraz ze zdjętą blokadą produkcji.
Poniższa tabela to przebieg domyślny. Przypadki, które przechodzą, w tym oba,
na których wykładała się stara reguła Requestly:

| URL | oczekiwane | wynik |
|---|---|---|
| `https://allegro.pl.allegrosandbox.pl/` | tag | OK |
| `https://x.allegro.pl.allegrosandbox.pl/kategoria` | tag | OK |
| `https://allegro.sk.allegrosandbox.pl/` | tag | OK |
| `https://allegro.cz.allegrosandbox.pl/` | tag | OK |
| `https://allegrosandbox.pl.cokolwiek.tld/` | **brak** | OK |
| `https://example.com/?q=allegro.pl.allegrosandbox.pl` | **brak** | OK |
| `https://evil.tld/https://allegro.pl.allegrosandbox.pl/` | **brak** | OK |
| `https://allegro.pl/`, `https://api.allegro.pl/x` | blok | OK |
| `https://allegro.sk/`, `https://allegro.cz/`, `https://www.allegrogroup.com/` | blok | OK |
| `https://wpengine.com/`, `https://my.wpengine.com/login` | tag | OK |
| `https://sub.wpengine.com/` | **brak** (host dokładny) | OK |
| `https://notwpengine.com/`, `https://wpengine.com.evil.tld/` | **brak** | OK |
| `https://foo.wpengine.io/asset.js`, `https://wpesvc.net/` | tag | OK |
| `https://app.getflywheel.com/`, `https://velocitize.com/`, `https://foo.flywheelsites.com/` | **brak** | OK |
| `https://nitropack.io/`, `https://marketing.nitropack.io/` | **brak** | OK |

Najdłuższy wygenerowany regex: **41 znaków** wobec limitu ~2000. Regexa używa
7 z 25 reguł: pozostałe idą przez `requestDomains`.

Przebieg kontrolny ze zdjętą blokadą daje 21 reguł zamiast 25 i zmienia wynik
wyłącznie dla pięciu przypadków `expect: "block"`. Gdyby zdjęcie blokady ruszyło
oznaczanie albo wykluczenia, test kończy się kodem 1.

### W Chrome, do wykonania po załadowaniu rozszerzenia

| krok protokołu | gdzie potwierdzasz | status |
|---|---|---|
| 1. zero „was skipped" | Diagnostyka na zielono | ☐ |
| 2. trafienie w cel | Tester 24/24 + Network na realnym hoście | ☐ |
| 3. brak wycieku | Tester, przypadki „brak" | ☐ |
| 4. blokada produkcji | stan zastany po instalacji: żądanie do `allegro.pl` nie wychodzi | ☐ |

Diagnostyka sprawdza rzecz, której interfejs Requestly nie sprawdzał w ogóle:
odczytuje z silnika listę faktycznie zainstalowanych reguł i porównuje ją
z zamierzoną. Reguła aktywna i martwa jednocześnie jest w tym modelu niemożliwa
do przeoczenia. Instalacja jest atomowa: jeśli choć jeden regex zostanie
odrzucony, nie instaluje się nic, więc nie ma stanu „część reguł działa".

---

## 4. Przełączanie blokady produkcji

Blokada jest **włączona domyślnie**. Wyłączasz ją świadomie i tylko na czas, gdy
jest to konieczne: stan jest trwały między restartami przeglądarki, więc sam się
nie przywróci. Przełącznik **Blokada produkcji** w popupie.

Odczyt stanu bez otwierania popupu: plakietka na ikonie:

| plakietka | znaczenie |
|---|---|
| `BLK` fioletowa | blokada produkcji **włączona**: stan normalny po instalacji |
| `ON` zielona | oznaczanie działa, ale **blokada produkcji zdjęta**: stan odstępstwa |
| `ERR` czerwona | któraś reguła nie przeszła: otwórz Diagnostykę, nie testuj |

Domyślnie po instalacji blokada i oznaczanie są **włączone**.

---

## 5. Ograniczenie blokady wobec pozycji „Other" w zakresie Allegro

**Blokada nie jest pełną ochroną.** Zakres Allegro zawiera pozycję typu *Other*
obejmującą każdą produkcyjną stronę Allegro nieujętą na liście domen. Blokada
pokrywa cztery wyliczone domeny wraz z subdomenami i **nic poza tym**. Wejście
na produkcyjną własność Allegro pod domeną spoza tej listy nie zostanie
zatrzymane.

To jest siatka bezpieczeństwa, nie gwarancja. Nie zastępuje sprawdzenia, na jaki
host się wchodzi, przed wejściem.

---

## 6. Świadomie pominięte

| pozycja | powód |
|---|---|
| `nitropack.io` w każdej postaci | Decyzja 2: aktywo nietestowane, a `marketing.nitropack.io` jest jawnie poza zakresem; koszt wycieku identyfikatora przewyższa korzyść z oznaczenia. **Uwaga:** techniczna przeszkoda z v2 zniknęła: DNR ma `excludedRequestDomains`, więc wykluczenie subdomeny da się wyrazić mimo braku negative lookahead w RE2. Gdy nitropack wejdzie do testów, wystarczy dopisać hosty i pole `excludedDomains` w programie. Decyzja pozostaje Twoja i nie została zmieniona. |
| `app.getflywheel.com` | czeka na odpowiedź programu; nietknięty, dodatkowo zabezpieczony regułą `allow` |
| `velocitize.com` | poza zakresem |
| `*.flywheelsites.com` | poza zakresem |
| nagłówki `Cookie` i `Authorization` | ograniczenie z v1 wynikało z wysyłki reguł do chmury Requestly; tu reguły nie opuszczają dysku, więc przeszkoda techniczna nie istnieje. Nie zostały dodane, bo nikt tego nie polecił: to jest decyzja do podjęcia, nie przeoczenie. |
| automatyczne wysyłanie żądań testowych | zakaz z v2; tester działa na `testMatchOutcome`, czyli symulacji silnika bez ruchu sieciowego |

---

## 7. Do rozstrzygnięcia: nie zgaduję

**Czy `*.wpengine.io` obejmuje apex `wpengine.io`?** Ustawiłem
`domainAndSubdomains`, czyli apex jest oznaczany: zgodnie z Twoim regexem z v1
(`^(.+\.)?domena\.tld$`), który apex obejmował, i z przyjętym raportem. Jeśli
program czyta wildcard ściśle jako „wyłącznie subdomeny", zmień `mode` na
`subdomains` przy siedmiu pozycjach wildcardowych. Dotyczy `advancedcustomfields.com`,
`bettersearchreplace.com`, `deliciousbrains.com`, `localwp.com`,
`studiopress.com`, `wpengine.io`, `wpesvc.net`.
