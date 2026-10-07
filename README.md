# syncRadio

Player statico per una o piu stazioni ufficiali. Le stazioni, i relativi metadati e l'inizio della timeline si configurano in `config.json`; ogni manifesto CSV contiene solo la scaletta. Lo switch tra stazioni è controllato dalla configurazione. I file possono essere pubblicati su qualsiasi hosting statico; non e previsto ne richiesto un backend applicativo.

## Configurazione

La configurazione personale `config.json` e esclusa da Git. Per crearla la prima volta, copia il template versionato:

```sh
cp config.example.json config.json
```

Modifica quindi `config.json` in locale e pubblicalo sul tuo hosting insieme alla pagina. Le modifiche personali a questo file non verranno incluse nei commit; `config.example.json` documenta invece la struttura e i valori iniziali:

- `stations`: lista di stazioni, ognuna con `id` univoco, `name`, `description`, `manifestUrl` (assoluto o relativo), `timelineStartsAt` (data ISO 8601 con fuso orario) e `repeat` opzionale (booleano, predefinito `false`). CSV e il formato raccomandato; i manifesti JSON sono ancora supportati.
- `allowStationSwitch`: abilita (`true`) o disabilita (`false`) lo switch utente tra le stazioni configurate. E visibile solo se ci sono almeno due stazioni.
- `stationQueryParam`: nome opzionale del parametro URL usato per scegliere la stazione. Il valore deve corrispondere all'`id` della stazione; ad esempio, con `"stationQueryParam": "station"`, `?station=radio-due` apre la stazione con `"id": "radio-due"`. Se il parametro manca o il valore non corrisponde a una stazione, viene caricata la prima della lista. Quando configurato, la selezione iniziale aggiorna l'URL senza creare una voce nella cronologia e i cambi dal selettore aggiornano l'URL; i parametri esistenti e il frammento sono mantenuti. Il parametro funziona anche se `allowStationSwitch` disabilita il selettore.
- `playbackOffsetQueryParam`: nome opzionale del parametro URL per condividere l'offset manuale in millisecondi; ad esempio, con `"playbackOffsetQueryParam": "offset"`, `?offset=350` applica un anticipo di 350 ms. Un valore valido nell'URL prevale sull'offset salvato nel browser; se il parametro manca, l'offset è zero. Valori fuori dal limite di +/-5000 ms vengono limitati; valori non validi sono trattati come zero. Quando l'offset è zero il parametro viene rimosso; i controlli dell'offset aggiornano l'URL e la cronologia, mantenendo gli altri parametri.
- `useManifestDurations`: se `true`, usa le durate della colonna `duration` del manifesto quando sono compilate e valide per tutte le tracce; se ne manca una, usa i metadati audio per l'intera scaletta. Il valore predefinito e `false`.
- `customTimeSource`: configurazione opzionale del futuro servizio orario proprietario. Con `url` vuoto resta disabilitato; quando l'endpoint sara disponibile, impostando l'URL valido verra provato prima delle sorgenti pubbliche. Prevede una risposta JSON con timestamp UTC nel campo `utc` (ad esempio `{"utc":"2026-10-07T09:00:00.000Z"}`); `responsePath`, `timeZonePath` e `responseFormat` sono configurabili.
- `timeSources`: lista ordinata di sorgenti orarie; la prima e la primaria e le successive sono tentate automaticamente come fallback. Ogni voce specifica `name`, `url`, `responsePath` e, se il timestamp non include il fuso, `timeZonePath`. `responseFormat` puo essere `json` (predefinito) o `text`.
- `resyncIntervalMs`: intervallo di risincronizzazione dell'orologio.
- `requestTimeoutMs`: budget massimo per provider orario e timeout per il manifesto.
- `localFallback`: se `true`, dopo il fallimento di tutte le API usa e segnala l'orologio del dispositivo; se `false`, disabilita sintonizzazione e timeline finche una sorgente non risponde.

Le sorgenti devono consentire richieste CORS dal dominio della radio e fornire un timestamp UTC. L'ordine configurato e TimeAPI.io (`timeapi.io`) come primaria, Cloudflare Trace come primo fallback e WorldTimeAPI come ultimo fallback. Nelle prove ripetute di ottobre 2026, TimeAPI.io ha risposto correttamente con HTTP 200, timestamp sub-secondo e `Access-Control-Allow-Origin: *`; Cloudflare Trace ha risposto con CORS ma il suo timestamp ha granularita al secondo. WorldTimeAPI ha resettato la connessione nelle prove da questo ambiente, quindi e lasciato in coda come sorgente indipendente ma non verificata raggiungibile in questo momento. Sono test puntuali da un ambiente specifico, non una misura statistica della disponibilita globale; i provider vanno monitorati in produzione. Entrambi gli host `timeapi.io` e `www.timeapi.io` hanno risposto direttamente (nessun redirect) con HTTP 200, CORS e lo stesso JSON; inoltre risolvono allo stesso IP. Non sono quindi due provider indipendenti e la configurazione usa una sola voce TimeAPI.io, senza duplicare l'host `www`. Gli endpoint v1 di TimeAPI.io provati restituiscono timestamp ad alta precisione, ma non hanno esposto l'header CORS nelle risposte controllate e non sono stati scelti per il browser. Se configurato, `customTimeSource` viene anteposto a tutte le sorgenti pubbliche; l'endpoint deve rispondere alle richieste CORS della pagina e restituire un timestamp UTC nel percorso JSON configurato (per default `utc`). Per ogni tentativo il client raccoglie fino a dieci campioni per provider entro il budget `requestTimeoutMs` e sceglie l'RTT minimo in una finestra mobile di massimo 32 campioni validi, mantenuti per non oltre due minuti; al cambio provider la finestra viene azzerata. La sincronizzazione iniziale e il pulsante **Risincronizza dispositivi** usano entrambi lo stesso obiettivo di dieci campioni freschi; in caso di errori o timeout possono raccoglierne meno, ma ne basta uno valido per attivare il provider. Il client seleziona il campione con RTT minore per ridurre l'effetto delle code di rete senza affidarsi a misure troppo vecchie; se non ottiene campioni validi, passa al provider successivo. Dopo la prima sincronizzazione, le correzioni automatiche dell'orologio vengono applicate gradualmente con una variazione massima del rate dello 0,5%, evitando salti della timeline; correzioni ampie richiedono quindi piu tempo per convergere. Il pulsante forza una nuova raccolta senza riusare campioni precedenti, applica subito la correzione UTC e riallinea l'audio se e in riproduzione; mantiene l'offset manuale e la compensazione automatica della latenza d'uscita. L'incertezza mostrata e stimata come meta dell'RTT selezionato, non e una garanzia e non corregge errori/asimmetrie del timestamp fornito dal servizio. La scheda risincronizza l'orologio quando torna visibile. Il client misura il tempo trascorso con `performance.now()` e mantiene l'ultima sincronizzazione valida se le successive richieste falliscono.

Questa architettura senza backend non implementa il protocollo NTP a quattro timestamp, coppie di sonde validate, heartbeat tra client, pianificazione di comandi condivisi o compensazione collettiva dell'uscita audio: tali funzioni richiedono un coordinatore raggiungibile da tutti i dispositivi. I client indipendenti si allineano invece alla medesima timeline UTC quando vengono sintonizzati; la latenza di avvio e uscita resta specifica di ogni dispositivo.

La pagina mostra provider e host attivi, ora UTC stimata al millisecondo, timestamp dell'ultimo campione API, scarto stimato dall'orologio del dispositivo, incertezza stimata come meta dell'RTT minimo, numero di campioni usati e codice HTTP. Elenca anche l'esito di ciascun provider provato e l'ultimo errore o avviso. Il messaggio di stato dell'orologio e questi dettagli sono raccolti in un pannello Telemetria inizialmente chiuso, espandibile quando serve; su schermi piccoli i controlli di ascolto, volume e correzione dell'offset hanno priorita e aree di tocco piu ampie.

`time.now` offre un sito world clock, ma non ho trovato un endpoint pubblico documentato che restituisca l'ora in un formato utilizzabile; i percorsi API verificati non hanno restituito un timestamp valido. Non e incluso come provider predefinito. Puoi aggiungerlo a `timeSources` se disponi della documentazione dell'endpoint e del formato.

Ogni sorgente si configura nella lista `timeSources` di `config.json`. Esempio di una voce:

```json
{
  "name": "Orologio UTC primario",
  "url": "https://example.org/api/time",
  "responsePath": "utc",
  "timeZonePath": ""
}
```

Il futuro servizio proprietario usa lo stesso formato di configurazione in `customTimeSource`, ma viene aggiunto automaticamente in testa a `timeSources` solo quando `url` non e vuoto.

`responsePath` e `timeZonePath` accettano percorsi separati da punti. Per `responseFormat: "json"` il timestamp deve includere `Z`/offset, oppure `timeZonePath` deve indicare esplicitamente `UTC`, `Etc/UTC`, `GMT` o `+00:00`. Per `responseFormat: "text"`, la risposta deve contenere campi `chiave=valore`, uno per riga; timestamp Unix in secondi (10 cifre, con frazione opzionale) sono accettati.

Esempio della configurazione delle stazioni:

```json
{
  "allowStationSwitch": true,
  "stations": [
    {
      "id": "radio-uno",
      "name": "Radio Uno",
      "description": "La prima stazione",
      "manifestUrl": "./radio-uno.csv",
      "timelineStartsAt": "2026-01-01T00:00:00.000Z",
      "repeat": true
    },
    {
      "id": "radio-due",
      "name": "Radio Due",
      "description": "La seconda stazione",
      "manifestUrl": "./radio-due.csv",
      "timelineStartsAt": "2026-01-01T01:00:00.000Z"
    }
  ]
}
```

La prima stazione della lista viene caricata all'apertura, salvo che `stationQueryParam` selezioni una stazione diversa. Con `allowStationSwitch: true` e almeno due voci, l'utente puo cambiare stazione dal selettore; il player interrompe la riproduzione corrente e carica la scaletta selezionata. I cambi di stazione vengono aggiunti alla cronologia del browser e sono navigabili con Avanti/Indietro.

## Manifesto CSV

E possibile usare un CSV pubblicato, ad esempio da un foglio Google. La prima riga deve contenere le intestazioni `id,title,artist,audioUrl`; ogni riga seguente rappresenta una traccia nell'ordine ufficiale. `timelineStartsAt`, nome e descrizione della stazione si configurano in `config.json` e non vanno ripetuti nel CSV. La colonna opzionale `duration` usa il formato `M:SS` o `M:SS.mmm`, ad esempio `3:20` o `3:19.750`. La durata viene usata solo con `useManifestDurations: true` e se e presente per ogni traccia; se manca in una o piu righe, l'intera scaletta usa le durate lette dai metadati audio. Una durata compilata ma malformata genera un errore. Il parser supporta campi tra virgolette e virgolette escape secondo le regole CSV.

## Manifesto JSON (alternativa)

```json
{
  "tracks": [
    {
      "id": "identificativo-univoco",
      "title": "Titolo",
      "artist": "Artista",
      "audioUrl": "https://example.org/audio.mp3",
      "duration": "3:20"
    }
  ]
}
```

L'inizio della timeline e specifico della stazione e deve essere una data ISO 8601 con fuso orario, preferibilmente `Z`, definita come `timelineStartsAt` nella relativa voce in `config.json`. L'ordine in `tracks` e l'ordine ufficiale di riproduzione. Con `repeat: false` o omesso la timeline termina al termine dell'ultima traccia; con `repeat: true` l'intera scaletta ricomincia indefinitamente. Ogni ciclo e calcolato dalla durata totale a partire dal medesimo `timelineStartsAt`, quindi chi ascolta si sintonizza sulla posizione condivisa anche dopo piu ripetizioni e non viene introdotto drift cumulativo. Per impostazione predefinita il browser legge i metadati di ogni file e ricava la durata arrotondata al millisecondo. Se `useManifestDurations` e attivo e tutte le tracce hanno il campo `duration`, usa i tempi del manifesto; eventuali differenze rispetto alla lunghezza effettiva possono quindi produrre tagli o silenzi tra tracce. Il caricamento della scaletta si completa solo quando tutte le durate necessarie sono disponibili.

All'avvio e dopo un'interruzione il player allinea la posizione alla timeline condivisa con una tolleranza di 10 ms; mentre la traccia continua a suonare non effettua nuovi seek. Un controllo ogni 50 ms rileva solo il cambio traccia previsto dalla timeline o una pausa imprevista, in modo da iniziare/riprendere dal punto ufficiale. Negli ultimi 10 secondi di una traccia il player precarica la successiva in un elemento audio standby e lo riutilizza al cambio; il browser puo limitare il preload e il caricamento anticipato aumenta il traffico di rete. A ogni nuova sintonizzazione viene letta, se disponibile, `AudioContext.outputLatency`: valori fino a 100 ms anticipano di altrettanto la posizione audio all'avvio, al cambio traccia e al riallineamento. Misure maggiori vengono ignorate come potenzialmente inattendibili; se la misura non e supportata o fallisce, la compensazione resta zero e il valore e mostrato nella telemetria. E una stima del percorso Web Audio e non misura direttamente il buffering specifico dell'elemento HTML audio, quindi puo non coincidere con la latenza udibile, specialmente con Bluetooth. La precisione effettiva resta soggetta a latenza e accuratezza del provider UTC, throttling dei timer del browser, buffering e latenza di uscita del dispositivo: il client punta a una tolleranza di 10 ms, ma una pagina web non puo garantirla in modo assoluto o identico su tutti i dispositivi.

Durante l'ascolto, il pulsante "Risincronizza dispositivi" aggiorna l'orologio UTC e riallinea l'audio al punto corrente della timeline senza mettere in pausa o riavviare la riproduzione. I pulsanti dell'offset correggono la timeline audio a passi di 50 ms, fino a +/-5000 ms: un valore positivo anticipa l'audio, uno negativo lo ritarda. La correzione viene salvata nel browser e resta attiva dopo una risincronizzazione o un aggiornamento della pagina. Il controllo del volume permette di regolare il livello e l'icona dell'altoparlante silenzia o riattiva l'audio senza perdere il volume impostato.

## Pubblicazione e limiti

Apri `index.html` da un server statico locale o dall'hosting, non tramite `file://`: i moduli e `fetch` richiedono un'origine HTTP. Gli URL del manifesto, dell'API e degli audio devono consentire CORS; la pagina HTTPS richiede URL audio HTTPS. Gli URL audio devono puntare direttamente a file riproducibili dal browser.

Se l'API dell'ora non e disponibile alla prima visita, l'interfaccia segnala che usa l'orologio locale e che la sincronizzazione condivisa non e garantita.

## Manifesto e scaletta di esempio

Il progetto include [`samples/station-manifest.csv`](./samples/station-manifest.csv), una scaletta con tre tracce audio ospitate in locale. La stazione di esempio e gia configurata in `config.json`. La timeline usa un inizio fisso e le durate effettive dei file; la scaletta e quindi riproducibile finche i file non cambiano, ma non e una programmazione in diretta e potrebbe risultare gia terminata rispetto all'ora corrente se `repeat` e disattivato.

Per verificare configurazione, caricamento e validazione dei manifesti JSON/CSV, orologio, player audio e passaggi esatti tra le tracce esegui `node --test`. I test usano risposte simulate e timestamp controllati e non dipendono da servizi esterni.

## Moduli

- `src/data-source.mjs`: caricamento e validazione dei manifesti JSON/CSV.
- `src/clock.mjs`: orologio comune basato sull'API configurata, con fallback dichiarato.
- `src/timeline.mjs`: calcolo deterministico della traccia dalla timeline ufficiale.
- `src/player.mjs`: adattatore del player HTML audio.
- `src/audio-output-latency.mjs`: stima best-effort della latenza d'uscita Web Audio, con soglia per scartare misure anomale.
- `src/app.mjs`: interfaccia e coordinamento; questi adattatori possono essere sostituiti senza cambiare il calcolo della timeline.
- `samples/`: manifesto e tracce audio locali per prove riproducibili.
- `test/`: test Node.js della configurazione, dei manifesti, dell'orologio, del player audio e della timeline.
