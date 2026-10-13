# FluidLab

**Ein Pneumatik-, Elektropneumatik-, Hydraulik- und Elektronik-Simulator im Browser — auf
einem echten Netzwerk-Solver, nicht auf abgespielter Animation.**

[![CI](https://github.com/alex-hahn/fluidlab/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-hahn/fluidlab/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/correctness%20gate-92%20bestanden-brightgreen)](docs/TESTING.md)
[![Abhängigkeiten](https://img.shields.io/badge/abhängigkeiten-0-brightgreen)](package.json)
[![Lizenz](https://img.shields.io/badge/lizenz-nicht--kommerziell-orange)](LICENSE)

*Read this in [English](README.md).*

![Der Editor mit geladener Schaltung](docs/screenshot-editor.png)

In der Tradition von Festo FluidSIM, aber die Physik wird gerechnet statt abgespielt. Jeder
Druck auf dem Bildschirm kommt aus einer Backward-Euler-Integration des Gaszustands über einem
Union-Find-Netzgraph; jeder Strom aus Modified Nodal Analysis mit Newton-Raphson an den
nichtlinearen Übergängen. 14.500 Zeilen ES-Module. Kein Build, keine Abhängigkeiten, kein
Framework.

Die vertiefenden Dokumente unter `docs/` sind auf Englisch; dieses README enthält den Inhalt
vollständig auf Deutsch.

---

## Schnellstart

```bash
git clone https://github.com/alex-hahn/fluidlab.git
cd fluidlab

npm start          # → http://localhost:8777   (serve.py, sendet no-store)
npm test           # → Correctness Gate, 92 Tests in 4 Suiten
```

`npm start` ist reine Bequemlichkeit — es gibt nichts zu installieren. Jeder statische Server
tut es (`python3 -m http.server 8777`), und `npm test` ist `node tests/run.js`. Node ≥ 18.

---

## Warum das kein Spielzeug ist

Das Interessante ist nicht die Bauteilzahl, sondern dass das Verhalten *entsteht*. Nichts
davon ist als Sonderfall einprogrammiert. Jede Zeile ist eine Messung, die das
[Correctness Gate](docs/TESTING.md) am fertigen System nimmt:

| Beobachtung | Messung |
| --- | --- |
| Drossel regelt Geschwindigkeit | 0,25 s → 0,29 → 0,47 → 1,00 → 2,71 s über den Stellbereich |
| Endlagendämpfung | Anschlag 0,913 → 0,060 m/s bei 16,5 bar Kammerdruck, für 2,2 % Taktzeit |
| …zu weit zugedreht wird sie zur Feder | Optimum bei 12 % Drossel; 2 % und 100 % sind beide schlechter |
| Schnellentlüftung | 62 % kürzere Einfahrzeit (0,125 s → 0,047 s) |
| Abluftdrosselung hält ziehende Last | 9,8 bar Gegendruck, 0,30 m/s kontrolliert |
| Zuluftdrosselung verliert sie | 0,2 bar, 1,28 m/s — 4,2× Kontrollverlust |
| Impulsventil speichert | hält Stellung 3 s ohne jedes Signal |
| Selbsthaltung | Relaiskontakte lesen Spulen einen Tick verzögert — physikalisch die Anzugszeit, und genau das bricht die algebraische Schleife |

Zu- gegen Abluftdrosselung ist die Zeile, auf die es ankommt. Keine Kennlinientabelle
erzeugt 4,2× Unterschied in der Kontrolle zwischen zwei Drosseln, die sich nur darin
unterscheiden, an welchem Anschluss sie sitzen — diese Zahl fällt aus dem ISO-6358-Gesetz im
Zusammenspiel mit einer Kraftbilanz samt Haftreibung heraus, oder sie fällt gar nicht heraus.

Zeitschritt 1 ms, ~190× Echtzeit.

![Laufende Simulation, Leitungsfarbe zeigt den gelösten Druck](docs/screenshot-running.png)

---

## Physik

### Strömung nach ISO 6358

Jede Drosselstelle wird über ihre sonische Leitfähigkeit `C` und ihr kritisches
Druckverhältnis `b` beschrieben — so, wie Pneumatikbauteile real katalogisiert sind, damit ein
Datenblattwert direkt eingetragen werden kann. Mit `r = p_ab/p_auf`:

    verblockt   (r ≤ b):  q = C · ρ₀ · p_auf
    unterschall (r > b):  q = C · ρ₀ · p_auf · √(1 − ((r−b)/(1−b))²)

Nahe dem Gleichgewicht hat das elliptische Gesetz unendliche Steigung; dort geht das Modell in
einen laminaren Ast über. Das ist kein numerischer Trick: bei kleiner Reynoldszahl ist die
reale Strömung dort auch laminar.

### Netzwerk

Alle Anschlüsse werden per Union-Find zu Druck-Netzen verschmolzen; jedes Netz ist ein
Gasspeicher. Pro 1-ms-Tick, Backward-Euler auf den Gaszustand:

    V/(R·T·dt) · (p_neu − p_alt) = Σ q_zu − p_alt/(R·T) · dV/dt

Der Term `p·dV/dt` ist die Kopplung Kolben↔Kammer: ein fahrender Kolben saugt und schiebt sein
Gas selbst. Die Nichtlinearität löst eine **gedämpfte Fixpunkt-Iteration**; jede Drosselstelle
wird pro Iteration auf einen Sekanten-Leitwert linearisiert. Iterationszahl und Residuum
stehen auf dem Snapshot, **Nicht-Konvergenz wird gemeldet, nie verschluckt**.

Backward-Euler statt eines expliziten Schritts ist eine bewusste Entscheidung: eine kleine
Kammer hinter einer großen Drossel ist steif, und ein expliziter Integrator bräuchte einen
Zeitschritt, den der steifste Knoten der Schaltung diktiert — nicht die Physik, die man
eigentlich sehen will.

### Mechanik

Kraftbilanz `p_A·A_A − p_B·A_B − Last − Reibung`, mit Reibung in drei Anteilen: **viskos**
(implizit integriert, weil m/c ≈ 1 ms bei 1-ms-Schritt sonst klingelt), **Coulomb**, und
**Haftreibung** — letztere ist, was einen Zylinder gegen kleine Druckdifferenzen *halten*
lässt statt zu kriechen. Ohne sie driftet jede Schaltung. Harte Endanschläge ohne
Überschwingen.

### Endlagendämpfung

Eine Dämpfung ist keine Bremse und ist auch nicht als solche modelliert — in der Kraftbilanz
steht nirgends ein Verzögerungsterm. Der Dämpfungsbund deckt auf den letzten Millimetern den
Hauptanschluss ab, die entweichende Luft muss stattdessen durch eine einstellbare Drossel, und
der Druck, der sich in der eingeschlossenen Kammer aufbaut, bremst den Kolben über dieselbe
Kraftbilanz wie alles andere.

Dafür muss die Kammer aufhören, ihr Anschluss zu *sein*. Überall sonst ist eine Kammer ein
Gasspeicher direkt auf dem Netz ihres Anschlusses — dazwischen ist kein Platz für eine
Drosselstelle. Der Zylinder beansprucht deshalb zwei **bauteilinterne Druckknoten**: dieselbe
Einrichtung, die der MNA-Zweig für interne elektrische Knoten nutzt, auf den Fluid-Solver
erweitert.

    offener Anschluss   C = 1,2e-7            (steif neben jedem Ventil)
    Bund dichtet ab     C = C_Anschluss·(1−d/0,25)² + C_Drossel   für d < 0,25
    abgedichtet         C = C_Drossel = Drossel · 1,25e-9

Zwei Details tragen die Sache, und beide kamen aus der Messung, nicht aus der Überlegung: Die
Drossel ist eine **absolute** Leitfähigkeit, kein Prozentsatz des Anschlusses — der Anschluss
ist zehnmal steifer als ein Ventilweg, ein Prozentsatz davon wäre immer noch weiter als der
Weg, den die Luft ohnehin nimmt, und die erste Fassung dämpfte aus genau diesem Grund gar
nicht. Und der Anschluss schließt über das **erste Viertel** der Dämpfungslänge, quadratisch:
eine lineare Überblendung über die volle Länge lässt bei halb eingetauchtem Bund noch das
Fünffache eines Ventilquerschnitts offen.

Das Rückschlagventil ist eine Richtungsprüfung am **Kolben**, nicht an der Druckdifferenz:
solange der Weg offen ist, sind die beiden Drücke bis aufs Solver-Rauschen gleich, und eine
Vorzeichenprüfung darauf flackert — sie schaltet die Dämpfung genau dann ab, wenn sie
einsetzen sollte.

| Beobachtung | Messung |
| --- | --- |
| Anschlaggeschwindigkeit, 2 kg an 25 mm Bohrung | 0,913 m/s → 0,060 m/s, 93 % weniger |
| Kammerdruck während der Dämpfung | 16,5 bar, deutlich über den 6 bar Versorgung — das ist der Beleg, dass Druck die Arbeit macht |
| Taktzeitkosten | +2,2 % ausfahren, +4,1 % einfahren; das Rückschlagventil hält den Füllhub frei |
| Drosselkennlinie, 2 kg | 2 %: 0,125 · 6 %: 0,098 · **12 %: 0,060** · 25 %: 0,400 · 50 %: 0,579 · 100 %: 0,724 m/s |
| Massenkennlinie bei fester Drossel | 0,5 kg: 57 % · 1 kg: 69 % · **2 kg: 93 %** · 4 kg: 36 % · 8 kg: 17 % |

Die beiden letzten Zeilen sind die interessanten, und keine davon ist programmiert. **Weiter
zudrehen macht die Dämpfung irgendwann schlechter**: Luft, die nicht entweichen kann, ist eine
Feder, und eine Feder gibt die gespeicherte Energie zurück, statt sie abzuführen. Und eine
feste Drossel hat ein **Massenfenster** — zu leicht, und der Kolben verdichtet nie genug Luft,
um Kraft zu erzeugen; zu schwer, und die Dämpfung ist schlicht überfordert. Genau deshalb ist
eine reale Dämpfungsdrossel überhaupt einstellbar, und deshalb geben Hersteller
Dämpfungsvermögen als Kennfeld an und nicht als Zahl.

### Hydraulik

Eine zweite Domäne mit eigener Physik, die sich denselben Solver teilt. Öl ist nahezu
inkompressibel, der Druck kommt aus der **Steifigkeit** des eingeschlossenen Volumens:

    V/(β·dt) · (p_neu − p_alt) = Σ q_vol − dV/dt

Strömung ist die Blendengleichung `q = K·sign(Δp)·√|Δp|`, unterhalb 0,1 bar laminar. Öl
kavitiert statt negativ zu werden: der Druck klemmt am Dampfdruck, nicht bei null. Öl- und
Luftanschlüsse liegen in getrennten Netzgraphen — der Editor verweigert die Verbindung
automatisch, ohne Sonderfall.

**β = 1,2e8, nicht die Lehrbuch-1,6e9.** Das ist die ehrliche Zahl für einen Kreis mit
Schlauch und ~1 % Lufteinschluss. Mit dem Reinöl-Wert war ein Knoten so steif, dass eine Pumpe
13 bar pro Millisekunde aufbaute — dreimal die gesamte Überdeckung eines DBV pro Tick — und
kein Druckbegrenzungsventil dagegen regeln konnte.

### Elektronik — MNA

Die Ladder ist ein rein resistiver DC-Solver: Leitwerte gegen feste Schienen, quadratisch und
linear, weil ein Relaiskreis nichts anderes enthält. Elektronik passt da in drei Punkten nicht
hinein, und jeder bekommt die Lehrbuchantwort:

- Eine **ideale Spannungsquelle** hat keinen Leitwert. Sie bringt eine eigene Unbekannte mit
  (ihren Zweigstrom) und eine eigene Zeile — das ist das *Modified* in MNA. Denselben Vorrat
  nutzt ein bauteilinterner Knoten; für die Matrix ist beides dasselbe.
- Ein **Kondensator** hängt an seiner eigenen Vorgeschichte und wird durch sein
  Backward-Euler-Companion ersetzt: Leitwert `C/dt` neben einer Stromquelle mit der Ladung,
  die schon auf den Platten liegt. Derselbe implizite Schritt wie bei Gas und Öl.
- Ein **pn-Übergang** ist exponentiell, also läuft pro Zeitschritt **Newton-Raphson** — nicht
  der gedämpfte Fixpunkt der Fluidseite: `exp()` hat eine analytische Ableitung, und keine
  Relaxation zähmt eine so steile Kurve. Die Schrittweitenbegrenzung ist SPICEs `pnjlim`: sie
  kürzt einen Schritt, lenkt ihn nie um, und konvergiert deshalb auf die echte Lösung statt
  auf eine gedämpfte.

**Der elektrische Zeitschritt ist vom Fluid-Takt entkoppelt.** Eine 100-kHz-Periode ist 10 µs
lang; auf der 1-ms-Tickgrenze abgetastet wird daraus eine Gleichspannung. Jedes kontinuierliche
Bauteil sagt über `electricDt`, welchen Schritt es braucht; der Tick wird in eine ganze Zahl
davon geteilt — bei 100 kHz sind das 4000 Schritte à 250 ns. Die Gate prüft beide Seiten:
100,000 kHz zurückgemessen mit Entkopplung, konstant −10 V ohne.

| Beobachtung | Messung |
| --- | --- |
| RC-Ladekurve gegen die analytische Lösung | größter relativer Fehler 0,45 % über 5 τ |
| 100-kHz-Rechteck, sub-tick abgetastet | 100,000 kHz zurückgemessen, 40 Abtastungen/Periode |
| dieselbe Quelle auf der Tickgrenze | konstant −10 V — genau das Aliasing |
| Diode | 0,83 V Fluss / −24 V Sperr, Verhältnis 2,3·10⁷ |
| Transistor als Schalter | U_CE 24 V → 50 mV, β_eff 10 statt 200 (übersteuert) |
| Sättigungs-Offsetspannung (Ebers-Moll) | 10,4 mV, 0,34 % Lastabhängigkeit bei 10× Last |
| MOSFET, √I_D-Extrapolation | liest U_th = 1,94 V zurück (deklariert 2,0) |
| Newton, Diode aus dem kalten Start | 7 Iterationen; danach 1 |

Der MNA-Zweig ist **pro Blatt zuschaltbar**: ohne kontinuierliches Bauteil läuft unverändert
der resistive Solver — inklusive Digital-Settle-Loop und der 1-Tick-Relaisverzögerung, an der
die Selbsthaltung hängt. Beide Zweige teilen sich denselben Netzgraph und dieselben
`stampElectric`-Bauteile, also schaltet ein Relaiskontakt einen RC-Kreis, ohne dass eines der
beiden davon weiß.

### Digitaltechnik

Gatter und Flipflops liegen auf demselben elektrischen Netzgraph wie die Ladder, nicht in
einer eigenen Boolean-Welt: ein Gatterausgang ist ein echter Knoten, also leuchtet eine Lampe
daran, und ein Gatter hinter einem Relaiskontakt liest ihn.

Das Timing trennt bewusst: **kombinatorische Gatter schwingen innerhalb eines Ticks ein** (die
Engine löst neu, bis die Pegel stehen — eine 5er-Kette braucht 7 Durchläufe, aber 1 Tick),
während **Flipflops auf der Tickgrenze takten**. Ein Gatter pro Tick würde einen 8-Bit-Addierer
8 ms brauchen lassen; ohne die Tickgrenze bei den Flipflops wäre jede Rückkopplung eine
algebraische Schleife.

---

## Architektur in einem Gedanken

**Eine Steuerung ist keine Schaltung.** Ein Stromlaufplan, ein GRAFCET und ein SPS-Programm
sind drei Notationen für eine Spezifikation *über* der Schaltung. Sie lesen deren Sensoren und
kommandieren deren Aktoren über genau einen schmalen Kanal — `sim.signal(tag)` rein,
`sim.energized` raus — und nichts darunter weiß, wer gerade spricht.

Deshalb kostete die Soft-SPS **keine Änderung an `engine.js`**, und deshalb weiß ein
Magnetventil nicht, ob eine Ladder, ein Ablaufplan, eine Soft-SPS oder eine echte SPS am
anderen Ende eines Sockets es ansteuert.

Zwei Folgerungen, auf denen der Code aufbaut:

- **Sonden sind bewusst keine Bauteile.** Kein Stamp, kein Port, kein Platz im Netzgraph — das
  ist der einzige Weg, die Forderung „darf die Schaltung nicht beeinflussen" zu *garantieren*
  statt zu beabsichtigen. Die Gate beweist es über 3000 Ticks mit 8 Sonden: identisch bis aufs
  letzte Bit. Abgetastet wird im Tick-Loop (1000/s), nicht im Frame-Loop — bei 60 fps würde
  jeder 17. Tick erfasst, was genau das Aliasing wäre.
- **Ein neues Bauteil ist ein Katalogeintrag.** Symbol, Anschlüsse, Physik, Defekte. Keine
  Engine-Änderung, keine Inspector-Änderung. Defekte deklariert jedes Bauteil selbst, der
  Inspector rendert, was angeboten wird — ein neuer Fehlertyp braucht keine UI-Arbeit.

### GRAFCET (EN 60848)

Bewusst **keine** Bauteile: ein GRAFCET ist eine Spezifikation über der Schaltung mit eigenen
Evolutionsregeln, die mit Netzen und Leitwerten nichts zu tun haben. In den elektrischen
Netzgraph gepresst müsste man Leitungen erfinden, die die Norm nicht kennt.

Umgesetzt sind R1–R5: Initialschritte aktiv beim Start; eine Transition ist *freigegeben*,
wenn alle Vorgängerschritte aktiv sind, und *feuerbereit*, wenn zusätzlich ihre Bedingung wahr
ist; Feuern deaktiviert alle Vorgänger und aktiviert alle Nachfolger; **alle feuerbereiten
Transitionen feuern gleichzeitig** gegen einen eingefrorenen Zustandsschnappschuss — sonst
sähe die zweite Transition schon das Ergebnis der ersten; ein Schritt, der gleichzeitig
aktiviert und deaktiviert wird, bleibt aktiv.

Transitionsbedingungen sind eine echte boolesche Sprache mit Rekursivabstieg-Parser (Vorrang
und Klammern gehen mit Regex nicht):

    S1              Anlagensignal per Kennzeichen
    X2              Schrittaktivität
    /S1  !S1        Negation
    S1 * S2         UND        S1 + S2   ODER
    ↑S1  ↓S1        steigende / fallende Flanke
    t/X2/5s         X2 ist seit 5 s aktiv
    ( )             Klammerung

Strukturprüfung meldet fehlenden Initialschritt, unerreichbare Schritte, Sackgassen, doppelte
Schrittnamen und Syntaxfehler — und schweigt bei einem korrekten Plan. Pläne werden im
**grafischen Editor** gezeichnet (Schritte setzen und verschieben, Transitionen verknüpfen,
Aktionen im Seitenpanel), mit Token-Anzeige während der Simulation.

### Soft-SPS und I/O-Ports

**Structured Text** (`src/plc.js`) ist ein Subset — und sagt das. Vorhanden: Zuweisung,
IF/ELSIF/ELSE, `AND OR XOR NOT` mit echtem Vorrang, Vergleiche, Arithmetik, `VAR`-Block,
Zeitliterale `T#500ms`, und die Bausteine TON, TOF, CTU, CTD im IEC-Aufruf
`T1(IN := x, PT := T#1s); done := T1.Q;`. Rekursivabstieg, kein Regex — aus demselben Grund
wie bei den Transitionsbedingungen: `a OR b AND NOT c` hat genau eine richtige Lesart, und ein
Pattern findet sie nicht. Ladder-Sprossen kompilieren in dieselben Closures, es gibt also nur
eine Laufzeit für beide Sprachen; die Gate prüft, dass Selbsthaltung in Ladder und ST Scan für
Scan identisch läuft.

Ein Scan ist `scan → Programm → flush`, vor `sim.step()`. Die Eingänge sind damit einen Tick
alt. Das ist keine Schlamperei, sondern der Eingangs-Scan einer echten SPS — und dieselbe
Verzögerung, die in der Ladder die algebraische Schleife bricht.

**I/O-Ports** (`src/io.js`) sind benannte digitale und analoge Ein-/Ausgänge mit einer Bindung
auf die Schaltung. Richtungen gelten aus Sicht der Logik: `in` liest sie, `out` schreibt sie —
ein externer Prozess sieht das Spiegelbild. Deshalb bedient dieselbe Karte beide Richtungen.
`set()` auf einen Eingang wirft, wie an echter Hardware auch; ein Programm darf seine eigenen
Sensoren nicht fälschen.

### Abgeleitet, nie gespeichert

Die **Stückliste** wird aus dem Plan gerechnet und nie persistiert — eine Stückliste, die von
der Schaltung abweichen kann, ist schlimmer als keine. Gruppiert nach Typ *und Ausführung*:
ein 25er und ein 50er Zylinder sind zwei Positionen, acht gleiche Ventile eine Zeile mit „8×".
Kennzeichen natürlich sortiert (1A1 vor 1A10 vor 2A1), scharfe Fehler ausgewiesen.

Der **Export** folgt derselben Regel: PNG entsteht durch Rastern desselben SVG, das der
SVG-Export schreibt — so können die beiden Ausgaben gar nicht auseinanderlaufen. Das
exportierte SVG ist eigenständig: eigene Styles inline, viewBox um den Inhalt, Schriftfeld mit
Datum, ohne Editor-Beiwerk (Anschlusspunkte, Auswahlrahmen, Raster).

---

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `src/engine.js` | ISO 6358 + Hydraulik-Blenden, Netze, Stamping, Fixpunkt-Iteration, Headless-API |
| `src/symbols.js` | ISO-1219-Primitive, Ventil-Renderer mit gleitendem Schieber |
| `src/catalog.js` | Pneumatik/Elektrik — Symbol, Anschlüsse, Physik und Defekte je Bauteil |
| `src/catalog-hydraulic.js` | Hydraulik-Bauteile, gleicher Vertrag |
| `src/catalog-electronics.js` | Elektronik-Bauteile, gleicher Vertrag plus MNA-Haken |
| `src/catalog-digital.js` | Gatter, Flipflops, Zähler, Taktgenerator |
| `src/circuit.js` | Dokumentmodell, Serialisierung, Beispiele |
| `src/grafcet.js` | Evolutionsregeln, Bedingungsparser, Strukturprüfung |
| `src/grafcet-view.js` | Plandarstellung, Token-Ansicht |
| `src/plc.js` | Soft-SPS: ST-Parser, Ladder, TON/TOF/CTU/CTD |
| `src/io.js` | I/O-Ports, Mock- und WebSocket-Treiber |
| `src/history.js` | Undo/Redo |
| `src/diagram.js` | Weg-Schritt-Diagramm, CSV |
| `src/scope.js` | Oszilloskop, virtuelle Messsonden |
| `src/partslist.js` | Stückliste |
| `src/export.js` | JSON / SVG / PNG / PDF / CSV |
| `src/panels.js` | Verstellbare Panels |
| `src/main.js` | Zeichenfläche, Direktmanipulation, Inspector, Laufschleife |
| `tests/gate.js` | Correctness Gate |
| `tests/gate-plc.js` | Gate für Soft-SPS und I/O |
| `tests/gate-electronics.js` | Gate für die kontinuierliche Elektronik |
| `tests/gate-pdf.js` | Gate für den PDF-Export |

Ein neues Bauteil braucht nur einen Eintrag in `catalog.js`. Die Schnittstelle ist oben in der
Datei dokumentiert.

---

## Bauteile (80)

**Antriebe** doppelt-/einfachwirkender Zylinder, Zylinder mit durchgehender Kolbenstange
(Kolben-Ø, Stangen-Ø, Hub, Masse, Last, viskose und Haft-/Gleitreibung)
**Versorgung** Druckluftquelle, Schalldämpfer ·
**Wegeventile** 3/2 (Taster NC/NO, Handhebel rastend, Rollenhebel), 5/2 Impuls, 5/3
Mittelstellung gesperrt, 3/2 und 5/2 magnetbetätigt ·
**Sperrventile** Rückschlag, ODER, UND, Schnellentlüftung ·
**Stromventile** Drosselrückschlagventil (Zu-/Abluft umschaltbar) ·
**Druckventile** Druckregelventil (mit eigener Membrankammer) ·
**Ventilgruppen** Zeitverzögerungsventil NC/NO, Druckfolgeventil ·
**Messtechnik** Manometer, Druckschalter (pneumatisch→elektrisch)

**Elektrik** 24V/0V, Taster, Relaisspule + Kontakte, Relais mit Anzugs-/Abfallverzögerung,
Relaiszähler, Magnetspule, Meldeleuchte, NOT-HALT, Grenztaster, Reed-/Induktiv-/Kapazitiv-/
Optisch-Näherungsschalter

**Hydraulik** Hydrozylinder, Tank, Konstantpumpe, Manometer, 4/3-Wegeventile (Sperr-,
Schwimm-, Umlaufmittelstellung; Handhebel und magnetbetätigt), Druckbegrenzungsventil,
Senkbremsventil, Rückschlag- und Drosselrückschlagventil

**Digitaltechnik** AND/OR/NOT/NAND/NOR/XOR (2 und 3 Eingänge), RS-Flipflop (setz-dominant),
D-Flipflop (flankengesteuert), Vorwahlzähler, Taktgenerator

**Elektronik** Widerstand, Kondensator, Spule, Potentiometer, Diode 1N4007, LED, Z-Diode,
NPN-/PNP-Transistor (Ebers-Moll), n-Kanal-MOSFET (quadratisch), Operationsverstärker,
Wechselspannungsquelle (Sinus/Rechteck/Dreieck bis 200 kHz), Transformator

Endlagenschalter werden im Inspector einem Zylinder und einer Hubposition zugeordnet. Spulen
und Kontakte koppeln über ihr Kennzeichen (K1, Y1 …), nicht über Verdrahtung — wie in
FluidSIM.

### Fehlerdiagnose

Jedes Bauteil deklariert seine typischen Defekte (`stuck`, `clogged`, `leak`, `off`, `seized`,
`coil_open`, `contact_welded`, `drift` …); der Inspector rendert, was das Bauteil anbietet.
Scharfgeschaltete Fehler werden auf dem Blatt markiert und sind undo-bar. Die Gate prüft, dass
ein steckendes Ventil die Sequenz an der erwarteten Stelle stehen lässt *und* die Prüfstelle
den erwarteten Druck zeigt.

### Beispiele

Direkte Steuerung · Indirekte Steuerung mit Impulsventil · Geschwindigkeitsregelung ·
Selbsttätige Hin- und Herbewegung · **A+ B+ A− B−** mit vier Endlagenventilen ·
Zeitverzögerung · Druckabhängige Folgesteuerung · Elektropneumatische Selbsthaltung ·
**Hydraulikpresse mit DBV** · **Last halten mit Senkbremse** · **GRAFCET: A+ B+ A− B−**

Das GRAFCET-Beispiel fährt dieselbe Sequenz wie die pneumatische Variante mit **10 statt 11
Bauteilen und ohne ein einziges Endlagenventil**: die Logik steckt im Plan, nicht in der
Verrohrung.

---

## Messtechnik

**Oszilloskop** 4 Kanäle, Zeitbasis 50 ms–10 s, Flankentrigger mit Pegel (Triggerpunkt bei
30 %, damit ein wiederkehrender Verlauf stehen bleibt), Cursor mit Δ-Ablesung, Freeze, CSV.

**Weg-Schritt-Diagramm** Zylinderhübe und Spulenzustände über gemeinsamer Zeitachse — die
Ansicht, aus der man Signalreihenfolge und -überlappung abliest. Binärkanäle als Rechteck
gezeichnet: ein Relais, das bei t schaltet, muss bei t schalten, nicht dorthin rampen.
CSV-Export.

---

## Bedienung

| | |
| --- | --- |
| `V` / `W` / `P` | Auswahl / Leitung / Messsonde |
| `R` | drehen · `Entf` löschen |
| `Cmd/Ctrl+Z` | rückgängig · `+Shift` wiederherstellen |
| `Leertaste` | Start / Pause · `Esc` Stopp |
| Ziehen am Anschlusspunkt | verbindet zwei Bauteile |
| Scrollen / `Strg`+Scrollen | verschieben / zoomen |
| Griffe zwischen den Panels | Breite/Höhe verstellen · Doppelklick setzt zurück |
| 4/3-Handhebel | linke oder rechte Symbolhälfte anklicken und halten |

Während der Simulation sind Taster und Handhebel anklickbar. Leitungsfarbe = gelöster Druck
(grau→blau), rot = stromführend.

---

## Correctness Gate

`npm test` — 92 Tests in 4 Suiten, ohne Framework. Sie prüfen **Verhalten, das aus der Physik
entsteht**, nicht dass Code existiert. Jeder ist so geschrieben, dass er fallen *kann*;
mehrere haben beim ersten Lauf real gefeuert und Fehler gefunden. Suiten werden entdeckt, nicht
gelistet: ein neues Gebiet legt `tests/gate-*.js` ab und läuft mit, ohne gemeinsame Datei, an
der parallele Arbeit kollidiert.

Eine bewusste Abweichung von der Spec: Sie verlangt bei Zu-/Abluftdrosselung „assert velocity
variance". Gegen dieses Modell gemessen ist das die falsche Metrik — Zuluftdrosselung liefert
die *niedrigere* Varianz (0,003 vs. 0,14), weil ein unkontrollierter Durchschlag eben
gleichmäßig ist. Der Test prüft stattdessen, wer die Geschwindigkeit bestimmt (Gegendruck +
Spitzengeschwindigkeit). Die Begründung steht im Test, neben der Zusicherung.

Zwei Ungenauigkeiten werden budgetiert statt versteckt: der Leckpfad `C_LEAK` lässt die
Massenerhaltung um ~0,05 %/2 s driften, und die BE-Diskretisierung ist um O(dt/τ) zu langsam
(0,45 % auf der RC-Kurve). Die Gate prüft beide Schranken, statt so zu tun, als wäre der
Fehler null.

---

## Grenzen — ehrlich

Ein Simulator, der seine Modellgrenzen nicht nennt, lädt zu Vertrauen ein, das er nicht tragen
kann. Vollständige Liste: [LIMITATIONS.md](docs/LIMITATIONS.md) (englisch). Die Kurzfassung:

**Nicht umgesetzt** — Mehrblatt-Projekte, i18n, Custom-Component-Editor, Sub-Circuits, Minimap,
Kreuzverweise Spule↔Kontakt, Proportional- und Vakuumtechnik. Die **Soft-SPS hat keinen
grafischen Editor** — Programme entstehen im Code (der GRAFCET hat einen). Der
**WebSocket-Treiber ist
ein Stub** — „neuester Wert gewinnt", nicht synchron, weil ein Netz-Roundtrip mehrere
Millisekunden Wanduhr braucht und ein Tick 1 ms Simulationszeit ist. Hydraulik sind 11
Bauteile statt der ~150 einer Vollbibliothek; Elektronik 13, Digitaltechnik 12.

**Modellgrenzen im Vorhandenen** — Schlauchvolumen ist unterschätzt (`V_PER_WIRE` bildet
~0,015 cm³ pro Längeneinheit ab, ein realer 4-mm-Schlauch hat ~12 cm³ pro Meter),
Endlagendämpfung nur am doppeltwirkenden Zylinder, keine Temperaturdynamik (isotherm bei 20 °C), kein Akkumulator, der
elektrische Zeitschritt ist fest statt adaptiv, der Op-Amp hat keinen Frequenzgang (kein Slew
Rate, kein GBW), Transistoren sind Ebers-Moll ohne Sperrschichtkapazitäten und Early-Effekt,
der Trafo koppelt ideal.

---

## Mitarbeit

Fünf Regeln halten diesen Code überschaubar: keine Abhängigkeiten, Physik die entsteht statt
skriptet zu sein, ein neues Bauteil als ein Katalogeintrag, Tests die Verhalten prüfen, und
ehrlich benannte Grenzen. Erklärt in [CONTRIBUTING.md](CONTRIBUTING.md) (englisch); die erste
Regel erzwingt die CI.

`main` ist geschützt — grünes Gate erforderlich, keine Force-Pushes.

## Lizenz

**[PolyForm Noncommercial 1.0.0](LICENSE) — nur nicht-kommerzielle Nutzung.**

Lesen, ausführen, studieren, verändern und weitergeben ist für jeden nicht-kommerziellen
Zweck frei: eigenes Studium, Forschung, Experiment, Hobbyprojekte, sowie Nutzung durch
Schulen, Hochschulen, öffentliche Forschungseinrichtungen, gemeinnützige Organisationen und
Behörden.

**Verkauf oder Einsatz in einem kommerziellen Produkt oder Dienst erfordert eine gesonderte
schriftliche Lizenz von mir.** Das schließt ein: Bündelung in ein kostenpflichtiges Angebot,
Nutzung für bezahlte Schulungen oder Beratung, und kommerzielle Weiterverbreitung. Wer das
vorhat, schreibt an alexanderhahn.br@gmail.com — ich bin dem gegenüber offen, will die
Bedingungen aber vorher vereinbaren.
