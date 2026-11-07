# ReADQuest

Rozszerzenie Chrome (MV3) do autoryzowanych testów bug bounty. Demo do pracy
magisterskiej. Repozytorium celowo poza repo pracy.

Ten plik jest nadrzędny wobec własnych pomysłów. Sekcje 2, 4 i 5 opisują decyzje
już podjęte i zweryfikowane: nie zmieniaj ich bez wyraźnej decyzji właściciela.

---

## 1. Stan projektu

```
manifest.json           MV3, host_permissions generowane z konfiguracji
scope.config.json       JEDYNE ŹRÓDŁO PRAWDY o zakresie i regułach
src/compile.js          konfiguracja -> reguły DNR; czysta funkcja, zero chrome.*
src/background.js       service worker: instalacja reguł, log trafień, diagnostyka
src/popup.{html,css,js} UI: przełączniki, diagnostyka, tester dopasowań
tools/sync-manifest.mjs generuje host_permissions z konfiguracji
tools/selftest.mjs      symulator DNR + bateria przypadków (offline, bez Chrome)
NOTATKA.md              protokół weryfikacji, checkboksy do wypełnienia ręcznie
```

Zaimplementowane: kompilator zakresu, tagowanie User-Agenta, twarde wykluczenia,
blok produkcji, diagnostyka odczytująca stan z silnika Chrome, tester dopasowań,
symulator offline.

Do zrobienia: sekcja 7.

## 2. Trzy tezy, których nie wolno rozmyć

**W1. Wymuszanie zakresu zamiast dokumentowania go.**
Narzędzie zna granicę autoryzacji programu i mechanicznie uniemożliwia jej
przekroczenie. Zakres jest obiektem pierwszej klasy: plikiem `scope.config.json`,
nie ustawieniem w UI.

**W2. Weryfikowalność przechwytywania.**
Interfejs nigdy nie twierdzi, że reguła działa, na podstawie samej konfiguracji.
Stan pochodzi z odczytu z silnika Chrome i porównania z zamiarem. Instalacja jest
atomowa, więc „reguła aktywna i martwa jednocześnie" jest konstrukcyjnie
niemożliwa. Motywacja jest udokumentowana: w produkcyjnym Requestly reguły
potrafią mieć status `Active` i być po cichu odrzucane przez Chrome, przez co ruch
leci w cel bez wymaganego identyfikatora badacza.

**W3. Replay tożsamości jako prymityw.**
Testowanie autoryzacji obiektowej sprowadzone do jednego kliknięcia: to samo
żądanie jako konto A i jako konto B, z diffem odpowiedzi. Jeszcze nie
zaimplementowane: patrz F3 w sekcji 7.

## 3. Pętla pracy

Po każdej zmianie `scope.config.json`:

```bash
node tools/sync-manifest.mjs   # host_permissions
node tools/selftest.mjs        # symulacja offline, musi być 100%
```

Potem w przeglądarce: `chrome://extensions` → Reload → popup → **Diagnostyka**.

**Tryb unpacked jest wymagany.** Log trafień (`onRuleMatchedDebug`) i tester
(`testMatchOutcome`) są w Chrome dostępne wyłącznie dla rozszerzeń ładowanych
lokalnie. To nie jest ograniczenie do obejścia: to założenie projektu.

Zmiana zakresu bez przejścia całej pętli jest niedokończona.

---

## 4. Fakty o MV3: ustalone, nie odkrywaj ich ponownie

**Limit 2 KB dotyczy wyłącznie `regexFilter`.** Regex z alternacją `(a|b|c)` po
kompilacji przekracza limit i reguła jest **po cichu pomijana**. Objaw:
`Rule with id N was skipped as the "regexFilter" value exceeded the 2KB memory
limit when compiled`.

**`requestDomains`, `excludedRequestDomains` i `urlFilter` nie kompilują regexa**
i limitowi nie podlegają. `requestDomains` dopasowuje domenę **oraz jej
subdomeny**: czyli robi to samo co `^(.+\.)?host$`, taniej i bez ryzyka.
Preferuj je wszędzie, gdzie się da.

**`excludedRequestDomains` istnieje.** Wykluczenia typu „`*.nitropack.io`
z wyjątkiem `marketing.nitropack.io`" **da się** wyrazić, mimo że RE2 nie ma
negative lookahead. Wykluczenie domeny obejmuje też jej subdomeny, więc jeden
wpis `marketing.nitropack.io` pokrywa również `www.marketing.nitropack.io`.

**Silnik regex to RE2**: brak lookahead i lookbehind. Logika zakresu żyje
w naszej warstwie decyzyjnej, nie w regexach oddawanych Chrome.

**`testMatchOutcome` pyta silnik „co byś zrobił z tym URL-em" bez wysyłania
żądania.** Dzięki temu weryfikacja „brak wycieku na hoście spoza zakresu"
odbywa się **bez wchodzenia na host spoza zakresu**. To jest właściwy sposób
sprawdzania i ma pierwszeństwo przed testami w realnej przeglądarce.

**Service worker MV3 jest efemeryczny**: ubijany po ok. 30 s bezczynności.
Żaden stan, który ma przeżyć, nie może istnieć wyłącznie w pamięci.

**`chrome.storage.local` ma limit kwotowy.** Ciała odpowiedzi (sekcja 7) idą
do IndexedDB, nie do storage.

## 5. Model reguł

Priorytety, ustalone i działające:

```
300  block   blok produkcji: wygrywa ze wszystkim
200  allow   neverTag: twarde wykluczenia
 10  tag     modifyHeaders: doklejenie identyfikatora do User-Agenta
```

Mechanizm: reguła `allow` o wyższym priorytecie powstrzymuje `modifyHeaders`
o niższym. To jest udokumentowane zachowanie DNR i na nim opiera się `neverTag`.

**Jedna reguła na host.** Nie konsoliduj dla oszczędności: limit to 5000 reguł,
a atrybucja w logu trafień i w testerze jest warta więcej niż kilkadziesiąt
wolnych slotów. Bez rozbicia log nie powie, która pozycja zakresu strzeliła.

Tryby hosta w `scope.config.json`:

```
exact                 tylko ten host, bez subdomen        (regexFilter, krótki)
domainAndSubdomains   host + wszystkie subdomeny          (requestDomains)
subdomains            wyłącznie subdomeny, apex pominięty (regexFilter)
```

### Pułapka do zapamiętania

`neverTag` tworzy regułę `allow` na `requestDomains: [host]`, czyli obejmuje host
**i jego subdomeny**, z priorytetem wyższym niż tagowanie. Jeżeli kiedykolwiek
przeniesiesz hosta z `neverTag` do `programs`, **musisz usunąć go z `neverTag`**:
inaczej tagowanie po cichu nie zadziała, a to jest dokładnie ta klasa awarii,
przeciwko której powstało W2. Symulator to wychwyci tylko wtedy, gdy dodasz
przypadek weryfikacyjny.

## 6. Zasada dla `scope.config.json`

Zakres pochodzi **wyłącznie** z aktualnej strony programu na Intigriti.
Nie przepisuj hostów z notatek, logów proxy ani z historii rozmów.

Każda pozycja `neverTag` ma mieć `reason`. Każda decyzja interpretacyjna
(apex czy tylko subdomeny, host wątpliwy) należy do właściciela projektu:
zgłoś ją, nie rozstrzygaj sam.

Każda zmiana zakresu wymaga dopisania przypadków do sekcji `verification`.
Zmiana bez testu jest niekompletna.

---

## 7. Roadmapa

Kolejność wiążąca. Każda pozycja ma być użyteczna sama w sobie.

### F1. Przechwytywanie ruchu przez CDP

**Decyzja architektoniczna: rdzeń przechwytywania na `chrome.debugger` + Chrome
DevTools Protocol, nie na `webRequest`.**

Pod MV3 `declarativeNetRequest` modyfikuje wyłącznie nagłówki i nie daje dostępu
do ciał. `webRequest` jest w praktyce obserwacyjny. Bez ciał odpowiedzi nie ma
podglądu par request/response, replayu ani diffowania: czyli nie ma produktu.

Domeny CDP: `Network.enable` → `requestWillBeSent`, `responseReceived`,
`loadingFinished`, `getResponseBody`. Do modyfikacji z ciałem: `Fetch.enable`
z `patterns` → `requestPaused`, `continueRequest`.

Dwie pułapki: żółty pasek „rozszerzenie debuguje przeglądarkę" jest nieusuwalny
i go akceptujemy; `Network.getResponseBody` ma okno czasowe: pobieraj ciało
w reakcji na `loadingFinished`, nie leniwie przy kliknięciu użytkownika.

**Ta decyzja jest droga do cofnięcia.** Architektura na `webRequest` wygląda
poprawnie do chwili, gdy potrzebne są ciała, i wtedy wymaga przepisania rdzenia.

DNR zostaje, do trwałego tagowania, które działa też bez podpiętego debuggera.

### F2. Zrzut z redakcją
Eksport: metoda, ścieżka, bezpieczne nagłówki, status, Content-Type, długość,
hash ciała. `Cookie`, `Authorization`, tokeny, e-maile, telefony, adresy:
wycięte i zastąpione placeholderami. Brak trybu „eksportuj surowo".

### F3. Replay tożsamości A/B  (teza W3)
Przechwycone żądanie → „wyślij jako konto B" → diff odpowiedzi.
Tożsamości to **referencje** do profili lub cookie stores, nigdy skopiowane
wartości sekretów.

### F4. Differ żądań
Dwa wpisy obok siebie, podświetlone różnice nagłówków i ciała. Motywacja: to samo
żądanie potrafi zwrócić 200 z przeglądarki i 404 z narzędzia, a przyczyną bywa
pojedynczy nagłówek.

### F5. Inwentarz endpointów
Tabela unikalnych host + metoda + ścieżka. Nadbudowa o realnej wartości:
**wykrywanie wariantów nazewnictwa**: `/shipping-addresses` obok
`/shippingAddresses` ma się samo podświetlić jako podejrzana para. Dwie trasy do
jednego zasobu to klasyczne miejsce rozjazdu autoryzacji.

### F6. Limiter zgodny z programem
Wymuszanie deklarowanego limitu żądań na sekundę. Limit należy do konfiguracji
programu w `scope.config.json`, nie do ustawień globalnych.

---

## 8. Zasady bezpieczeństwa narzędzia

Narzędzie dwojakiego zastosowania. Poniższe nie podlega negocjacji.

- **Nie budujemy** skanera, fuzzera, enumeratora identyfikatorów ani niczego
  generującego ruch masowy. Programy bug bounty zakazują tego wprost.
- **Nie budujemy** obchodzenia CAPTCHA, WAF-ów ani limitów. Limiter je respektuje.
- Blok produkcji i wykluczenia są **domyślnie włączone**. Wyłączenie wymaga
  świadomej akcji i jest widoczne w UI przez cały czas jej trwania.
- Narzędzie nie wysyła żądania, którego użytkownik nie zainicjował.
- Tagowanie **dokleja** identyfikator do pełnego User-Agenta przeglądarki,
  nigdy nie zastępuje całej wartości. Podmiana na krótki string rozjeżdża
  fingerprint i prowokuje blokadę ochrony antybotowej, a jej obchodzenie jest
  zakazane w regulaminach.

## 9. Higiena danych

- **Nigdy w trwałym magazynie**: wartości `Cookie`, `Authorization`, tokenów,
  haseł, OTP, kluczy API. W UI pokazywane zamaskowane, z jawną akcją odsłonięcia.
- Przechwycony ruch zostaje lokalnie. Zero telemetrii, zero synchronizacji
  w chmurze, zero wywołań sieciowych z rozszerzenia poza tymi, które inicjuje
  użytkownik.
- Reguły są plikiem na dysku: nie wychodzą nigdzie. To jest przewaga nad
  narzędziami synchronizującymi konfigurację do chmury.

## 10. Konwencje

- Uprawnienia minimalne. Każde nowe wymaga uzasadnienia w komentarzu przy
  manifeście. Obecne: `declarativeNetRequest`, `declarativeNetRequestFeedback`,
  `storage`. F1 dołoży `debugger`, `sidePanel`, `unlimitedStorage`.
- Bez zależności zewnętrznych w kodzie rozszerzenia, jeśli da się bez nich:
  każda biblioteka w bundlu to powierzchnia do uzasadnienia w pracy.
- `compile.js` zostaje czystą funkcją bez `chrome.*`. To dzięki temu istnieje
  symulator offline i to on jest najtańszą siatką bezpieczeństwa w projekcie.
- Identyfikatory i nazwy plików po angielsku, komentarze i UI po polsku.

## 11. Definition of done

1. `node tools/selftest.mjs` przechodzi w 100%, z nowymi przypadkami dla zmiany.
2. Diagnostyka w popupie pokazuje zgodność zamiaru ze stanem silnika Chrome.
3. Działa po ubiciu i wznowieniu service workera.
4. Żaden sekret nie trafia do trwałego magazynu.
5. Stan błędu jest widoczny w UI. **Cicha awaria jest błędem krytycznym**:
   cała teza W2 dotyczy właśnie cichych awarii.
6. Da się opisać w pracy jednym akapitem: co robi i jaki problem rozwiązuje.

## 12. Przy pracy nad tym repo

- Zanim zaproponujesz zmianę rdzenia: przeczytaj sekcje 4 i 5. Większość
  „uproszczeń" prowadzi z powrotem do `webRequest` i utraty ciał odpowiedzi.
- Przy każdej zmianie dotykającej reguł sprawdź, czy nie wprowadzasz regexa
  z alternacją. To najczęstsza cicha awaria w tej klasie narzędzi.
- Nie dodawaj funkcji spoza sekcji 7 bez rozmowy. Zakres jest wąski celowo:
  praca broni trzech tez, a nie długiej listy możliwości.
- Interpretacje zakresu zgłaszaj właścicielowi. Nie rozstrzygaj ich sam.
