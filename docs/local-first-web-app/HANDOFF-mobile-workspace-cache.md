# Handoff: mobiele web-app leest alle bestanden opnieuw in

**Repository:** `jefvanzanten/NoteMarkdownApps`  
**Scope:** `apps/web-app`, `packages/workspace-core`, `packages/workspace-drive`  
**Status:** superseded by an accepted architecture decision and implementation plan  
**Canonical decision:** [ADR 0004 — Local-first workspace cache and priority reconciliation](decisions/0004-local-first-workspace-cache-and-priority-reconciliation.md)  
**Implementation plan:** [Mobile workspace cache and reconciliation](../plans/mobile-workspace-cache-and-reconciliation.md)

> Dit document blijft bewaard als oorspronkelijke probleemanalyse. De ADR, canonieke productdocumentatie en het uitvoeringsplan zijn leidend wanneer voorstellen hieronder afwijken van de besloten oplossing.

---

## 1. Probleem

Bij het opnieuw starten of activeren van een workspace leest de mobiele web-app alle Markdown-bestanden opnieuw in.

Gevolgen:

- trage startup;
- veel Google Drive-requests;
- onnodig dataverbruik;
- extra CPU-, decryptie- en IndexedDB-werk;
- grotere kans op rate limiting;
- slechte ervaring bij grote workspaces of een instabiele verbinding.

De app heeft al lokale caches, waaronder zoekdocumenten, drafts, sessies en een versleutelde Drive mirror. Die caches worden momenteel niet gebruikt om online downloads van ongewijzigde bestanden te voorkomen.

---

## 2. Waarschijnlijke oorzaken

### 2.1 Volledige indexering bij provideractivatie

Bestand:

```text
apps/web-app/src/state/workspaceStore.ts
```

De activatieflow doet ongeveer het volgende:

1. `provider.listEntries()`;
2. lokale zoekdocumenten laden;
3. sessietabs via `provider.readDocument()` openen;
4. `indexWorkspace()` starten.

`indexWorkspace()` loopt door alle documentpaden en roept voor ieder bestand `provider.readDocument()` aan.

De geladen zoekcache vult dus wel de zoekfunctionaliteit, maar voorkomt geen nieuwe reads.

### 2.2 Drive-provider downloadt online altijd content

Bestand:

```text
packages/workspace-drive/src/driveWorkspaceProvider.ts
```

`DriveWorkspaceProvider.readDocument()` downloadt het bestand met `alt=media` en schrijft het daarna naar de lokale mirror.

De mirror lijkt vooral als offline fallback te worden gebruikt. Bij een online restart wordt de lokale revision niet eerst vergeleken met de revision uit Drive-metadata.

Drive heeft tijdens de directoryscan al metadata waarmee een revision kan worden samengesteld, zoals:

```text
version
md5Checksum
modifiedTime
size
```

Daardoor kan de provider bepalen of de lokale mirror nog actueel is zonder de volledige content opnieuw te downloaden.

### 2.3 Controle op externe wijzigingen leest volledige documenten

Bestanden:

```text
apps/web-app/src/App.tsx
apps/web-app/src/state/workspaceStore.ts
```

De app controleert periodiek en bij lifecycle-events of geopende bestanden extern zijn gewijzigd.

Wanneer deze controle `provider.readDocument()` gebruikt, downloadt Drive de volledige content alleen om daarna de revision te vergelijken.

Dit moet metadata-first worden.

### 2.4 Geen persistente workspace-manifest

De app bewaart lokale documentgerelateerde gegevens, maar waarschijnlijk geen complete persistente manifest met:

- bestandspaden;
- Drive file IDs;
- parent IDs;
- revisions;
- verwijderingsstatus;
- laatste syncstatus;
- Drive change token.

Daardoor moet Drive bij iedere activatie de folderstructuur opnieuw recursief opbouwen.

---

## 3. Doelgedrag

### Warme start

Bij een restart moet de app:

1. lokale workspace-state direct tonen;
2. lokale content gebruiken wanneer de bekende remote revision gelijk is;
3. geen ongewijzigde Markdown-content opnieuw downloaden;
4. remote synchronisatie uitvoeren zonder de UI te blokkeren.

### Externe wijzigingen

Wanneer niets is veranderd:

- geen `alt=media`-downloads;
- hoogstens lichte metadata- of changes-requests.

Wanneer één bestand is veranderd:

- alleen dat bestand downloaden;
- alleen dat bestand opnieuw indexeren;
- tab, diagnostics en lokale cache gericht bijwerken.

### Offline

Eerder gecachte documenten moeten beschikbaar blijven. Niet-gecachete bestanden moeten een duidelijke offline-status geven.

---

# 4. Aanbevolen aanpak

Een volledige rewrite is niet nodig om het grootste probleem op te lossen.

Voer de oplossing gefaseerd uit.

---

# Fase 1 — gerichte fix zonder architectuurrewrite

## 4.1 Maak Drive reads cache-aware

Pas `DriveWorkspaceProvider.readDocument()` aan zodat eerst de revision van de lokale mirror wordt vergeleken met de revision uit de reeds geladen Drive-metadata.

Voorbeeld:

```ts
async readDocument(path: string): Promise<WorkspaceDocument> {
  const mirrored = await this.options.mirror?.loadDocument(path);

  try {
    const file = await this.resolve(path);
    const remoteRevision = revision(file);

    if (mirrored?.revision.id === remoteRevision.id) {
      return mirrored;
    }

    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
    );

    const document = decodeDocument(
      path,
      file,
      await response.arrayBuffer(),
    );

    await this.options.mirror?.saveDocument(document);
    return document;
  } catch (error) {
    if (
      mirrored &&
      error instanceof WorkspaceError &&
      error.code === "offline"
    ) {
      return mirrored;
    }

    throw error;
  }
}
```

### Resultaat

Na `listEntries()` bevat de provider actuele metadata.

Voor een ongewijzigd bestand:

```text
Drive metadata gevonden
→ revision gelijk
→ document uit lokale mirror
→ geen alt=media-download
```

Voor een gewijzigd bestand:

```text
revision verschillend
→ content opnieuw downloaden
→ mirror overschrijven
```

### Belangrijk

Een mirror-hit is alleen veilig wanneer de metadata waarmee wordt vergeleken actueel is.

---

## 4.2 Voeg een metadata-only revision API toe

De providerinterface moet revisions kunnen controleren zonder de volledige content te lezen.

Bestand:

```text
packages/workspace-core/src/types.ts
```

Voorstel:

```ts
export interface WorkspaceProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: WorkspaceCapabilities;

  listEntries(): Promise<WorkspaceEntry[]>;
  readDocument(path: string): Promise<WorkspaceDocument>;

  getDocumentRevision?(
    path: string,
  ): Promise<WorkspaceRevision>;

  // overige bestaande methods
}
```

Drive-implementatie:

```ts
async getDocumentRevision(
  path: string,
): Promise<WorkspaceRevision> {
  const file = await this.resolve(path);

  const response = await this.request(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}` +
      "?fields=id,name,mimeType,modifiedTime,size,md5Checksum,version,parents",
  );

  const current = await response.json() as DriveFile;
  this.filesByPath.set(path, current);

  return revision(current);
}
```

Voor de lokale provider kan een vergelijkbare methode `FileSystemFileHandle.getFile()` gebruiken en alleen metadata zoals `lastModified` en `size` uitlezen.

---

## 4.3 Maak externe controles metadata-first

Bestand:

```text
apps/web-app/src/state/workspaceStore.ts
```

Gewenste flow:

```ts
const currentRevision =
  await provider.getDocumentRevision?.(tab.path);

if (
  currentRevision &&
  currentRevision.id === tab.revision.id
) {
  continue;
}

const external = await provider.readDocument(tab.path);
```

Alleen wanneer de revision verschilt, wordt de volledige content opgehaald.

Voor providers zonder `getDocumentRevision()` kan tijdelijk worden teruggevallen op het bestaande gedrag.

---

## 4.4 Dedupliceer en vertraag lifecycle-checks

Bestand:

```text
apps/web-app/src/App.tsx
```

Voorkom:

- meerdere gelijktijdige checks;
- een check bij zowel focus als visibility in korte tijd;
- checks wanneer de pagina verborgen is;
- checks wanneer de app offline is;
- een agressieve interval van ongeveer twaalf seconden.

Voorstel:

```ts
useEffect(() => {
  let running = false;
  let lastCheckAt = 0;

  const check = async () => {
    if (running) return;
    if (!navigator.onLine) return;
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheckAt < 60_000) return;

    running = true;
    lastCheckAt = Date.now();

    try {
      await checkExternalChanges();
    } finally {
      running = false;
    }
  };

  const interval = window.setInterval(() => {
    void check();
  }, 60_000);

  const handleFocus = () => void check();

  const handleVisibility = () => {
    if (document.visibilityState === "visible") {
      void check();
    }
  };

  window.addEventListener("focus", handleFocus);
  document.addEventListener(
    "visibilitychange",
    handleVisibility,
  );

  return () => {
    window.clearInterval(interval);
    window.removeEventListener("focus", handleFocus);
    document.removeEventListener(
      "visibilitychange",
      handleVisibility,
    );
  };
}, [checkExternalChanges]);
```

---

## 4.5 Gebruik de warme zoekcache direct

Wanneer `loadSearchDocuments(provider.id)` al documenten teruggeeft, kunnen die direct worden gebruikt voor zoeken en initiële diagnostics.

Voorbeeld:

```ts
const cachedSearch =
  await loadSearchDocuments(provider.id);

replaceSearchDocuments(cachedSearch);

const requiresInitialIndex =
  cachedSearch.length === 0;

const cachedDiagnostics =
  calculateDiagnostics(cachedSearch, entries);

set({
  provider,
  entries,
  tabs,
  activePath,
  selectedPath: session?.selectedPath ?? activePath,
  isOpening: false,
  isIndexing: requiresInitialIndex,
  diagnostics: cachedDiagnostics,
  error: null,
});
```

Alleen volledig indexeren wanneer er geen bruikbare cache bestaat:

```ts
if (requiresInitialIndex) {
  void indexWorkspace(
    provider,
    entries,
    (_documents, diagnostics) => {
      if (get().provider?.id === provider.id) {
        set({
          diagnostics,
          isIndexing: false,
        });
      }
    },
  );
}
```

### Beperking

Alleen controleren op `cachedSearch.length > 0` is niet robuust genoeg. De cache kan incompleet of verouderd zijn.

Deze wijziging is alleen geschikt als tijdelijke optimalisatie of in combinatie met revision-validatie en cache-reconciliatie.

---

# Fase 2 — persistente local-first workspace-cache

## 5.1 Voeg IndexedDB-stores toe

Verhoog de databaseversie en voeg bijvoorbeeld toe:

```text
workspaceManifests
documentCache
syncState
```

Datamodellen:

```ts
export interface StoredWorkspaceManifest {
  workspaceId: string;
  entries: WorkspaceEntry[];
  updatedAt: number;
}

export interface StoredDocumentCache {
  workspaceId: string;
  path: string;
  content: string;
  format: DocumentFormat;
  revision: WorkspaceRevision;
  updatedAt: number;
}

export interface StoredSyncState {
  workspaceId: string;
  providerType: "local" | "drive";
  drivePageToken?: string;
  lastFullScanAt: number;
  lastSyncAt?: number;
}
```

Voor Drive:

```ts
interface StoredDriveEntry {
  id: string;
  path: string;
  name: string;
  mimeType: string;
  parentIds: string[];
  revision: WorkspaceRevision;
}
```

---

## 5.2 Nieuwe startup-flow

```text
1. Open IndexedDB.
2. Laad de workspace-manifest.
3. Laad sessie en benodigde documentcache.
4. Render de UI direct.
5. Start remote reconciliatie.
6. Download alleen gewijzigde of ontbrekende content.
7. Werk manifest, zoekindex en diagnostics incrementeel bij.
```

De UI wacht dan niet meer op een volledige Drive-scan.

---

## 5.3 Reconciliatie

Vergelijk per entry:

```text
cached path + cached revision
met
remote path + remote revision
```

| Situatie | Actie |
|---|---|
| Pad en revision gelijk | niets doen |
| Nieuw remote bestand | metadata toevoegen; content lazy laden of indexeren |
| Gewijzigde revision | alleen dit document downloaden |
| Remote verwijderd | uit manifest en index verwijderen |
| Open clean document gewijzigd | nieuwe content toepassen |
| Open dirty document gewijzigd | conflictstatus instellen |
| Rename of move | stabiele Drive file ID gebruiken |

Dirty drafts mogen nooit stil worden overschreven.

---

# Fase 3 — Google Drive Changes API

Een manifest voorkomt contentdownloads, maar niet automatisch de volledige directoryscan.

Gebruik voor grotere workspaces de Drive Changes API.

## Eerste synchronisatie

```text
1. Volledige workspacefolder scannen.
2. Manifest en documenten opslaan.
3. Drive start page token opvragen.
4. Token lokaal opslaan.
```

## Vervolgstart

```text
1. Lokaal manifest tonen.
2. changes.list uitvoeren vanaf opgeslagen token.
3. Alleen gewijzigde Drive entries verwerken.
4. Nieuwe page token opslaan.
```

## Benodigde metadata

Bewaar minimaal:

- workspace root folder ID;
- Drive file ID;
- parent IDs;
- huidige pathmapping;
- revision;
- verwijderingsstatus;
- laatste page token.

Drive changes kunnen breder zijn dan de geselecteerde workspacefolder. Filter daarom op entries die tot de workspace behoren.

---

# 6. Opties en trade-offs

## Optie A — alleen volledige indexscan overslaan

### Voordelen

- kleinste wijziging;
- snelste startupwinst.

### Nadelen

- zoekindex kan verouderd raken;
- externe wijzigingen worden niet betrouwbaar verwerkt;
- verwijderde bestanden kunnen in de cache blijven.

Geschikt als tijdelijke noodpatch.

---

## Optie B — cache-aware reads

### Voordelen

- veel minder contentdownloads;
- past in de huidige architectuur;
- weinig UI-wijzigingen nodig.

### Nadelen

- `listEntries()` blijft mogelijk volledig recursief;
- lokale metadata moet betrouwbaar actueel zijn.

Dit is de aanbevolen eerste structurele wijziging.

---

## Optie C — metadata-first polling

### Voordelen

- geopende tabs worden niet steeds volledig gedownload;
- klein netwerkverbruik;
- goed te testen.

### Nadelen

- kan nog steeds veel metadatarequests opleveren bij veel open tabs;
- batching is wenselijk.

Aanbevolen samen met optie B.

---

## Optie D — persistent manifest

### Voordelen

- UI kan direct lokaal starten;
- incrementele indexering;
- duidelijke syncstatus;
- goede basis voor offline-first gedrag.

### Nadelen

- IndexedDB-migratie;
- rename-, delete- en conflictlogica nodig;
- meer architectuurwerk.

Aanbevolen als tweede fase.

---

## Optie E — Drive Changes API

### Voordelen

- geen volledige folderboomscan bij iedere start;
- schaalbaar voor grote workspaces;
- alleen delta's verwerken.

### Nadelen

- complexere mapping van changes naar de geselecteerde folder;
- tokenverlies en resync moeten worden afgehandeld;
- periodieke volledige controle blijft verstandig.

Aanbevolen voor de uiteindelijke robuuste implementatie.

---

## Optie F — volledige local-first rewrite

Architectuur:

```text
React UI
  ↓
Local document repository
  ↓
IndexedDB of SQLite
  ↓
Outbox + sync engine
  ↓
Google Drive
```

### Voordelen

- lokale opslag is de primaire bron;
- zeer goede offline-ervaring;
- duidelijke sync- en conflictlaag;
- UI is losgekoppeld van remote providers.

### Nadelen

- grote rewrite;
- veel migratie- en conflictrisico;
- waarschijnlijk niet nodig voor het huidige probleem.

Niet aanbevolen als eerste oplossing.

---

# 7. Privacy- en opslagpunt

Controleer of de verschillende caches dezelfde privacygaranties hebben.

De encrypted Drive mirror kan Markdown versleuteld bewaren, terwijl zoekdocumenten, drafts en history mogelijk dezelfde inhoud plaintext opslaan.

Kies expliciet:

1. lokale plaintext-opslag accepteren en documenteren; of
2. alle Drive-afgeleide content versleutelen.

Dit veroorzaakt de herleesbug niet, maar wordt belangrijk wanneer de mirror de primaire warme cache wordt.

---

# 8. Persistent browser storage

Vraag waar mogelijk persistent storage aan:

```ts
export async function requestPersistentStorage():
  Promise<boolean> {
  if (!navigator.storage?.persist) {
    return false;
  }

  return navigator.storage.persist();
}
```

Dit verkleint de kans dat mobiele browsers IndexedDB bij opslagdruk verwijderen.

Het is geen garantie. Een ontbrekende cache moet altijd als geldige cold-startsituatie worden behandeld.

---

# 9. Implementatievolgorde

## Pull request 1 — stop ongewijzigde contentdownloads

- [ ] `DriveWorkspaceProvider.readDocument()` revision-aware maken.
- [ ] Mirror-hit gebruiken wanneer revisions gelijk zijn.
- [ ] Unit tests toevoegen.
- [ ] Assertie toevoegen dat geen `alt=media` wordt aangeroepen bij een cache-hit.

## Pull request 2 — metadata-first externe controles

- [ ] `getDocumentRevision()` toevoegen aan de providerinterface.
- [ ] Drive-implementatie toevoegen.
- [ ] Lokale provider ondersteunen of fallback behouden.
- [ ] `checkExternalChanges()` metadata-first maken.
- [ ] Polling dedupliceren en vertragen.

## Pull request 3 — warme startup

- [ ] Zoekcache direct gebruiken.
- [ ] Alleen ontbrekende of gewijzigde documenten indexeren.
- [ ] Verwijderde cache-items opruimen.
- [ ] Startup- en netwerkmetingen toevoegen.

## Pull request 4 — persistent manifest

- [ ] IndexedDB-migratie.
- [ ] Entries, file IDs en revisions opslaan.
- [ ] UI lokaal-first initialiseren.
- [ ] Reconciler toevoegen.

## Pull request 5 — Drive delta sync

- [ ] Start page token opslaan.
- [ ] Changes verwerken.
- [ ] Rename, move en delete afhandelen.
- [ ] Periodieke volledige veiligheidsscan toevoegen.
- [ ] Tokenverlies en volledige resync ondersteunen.

---

# 10. Testplan

Gebruik een testworkspace met bijvoorbeeld:

```text
500 Markdown-bestanden
50 directories
5 geopende tabs
```

Meet requests met een instrumented `fetch` of Playwright network logging.

## Cold start

Verwachting:

- volledige metadata- en contentsynchronisatie toegestaan;
- cache wordt correct opgebouwd.

## Warm start zonder wijzigingen

Na fase 1:

- directorymetadata kan nog worden gescand;
- nul `alt=media`-downloads voor ongewijzigde documenten.

Na fase 3:

- geen volledige folderboomscan;
- alleen delta- of changes-request;
- nul contentdownloads.

## Eén extern gewijzigd document

Verwachting:

- één contentdownload;
- alleen dit document opnieuw indexeren;
- overige documenten blijven uit cache komen.

## Offline restart

Verwachting:

- gecachte tabs en documenten openen;
- dirty drafts blijven behouden;
- niet-gecachete bestanden tonen een duidelijke status.

## Conflict

Situatie:

- gebruiker heeft lokaal unsaved wijzigingen;
- hetzelfde bestand is remote gewijzigd.

Verwachting:

- lokale inhoud niet overschrijven;
- tab op `conflicted` zetten;
- remote revision bewaren voor conflictresolutie.

---

# 11. Acceptatiecriteria

- [ ] Een warme mobiele restart downloadt geen ongewijzigde Markdown-bestanden.
- [ ] External-change-checks downloaden geen content wanneer revisions gelijk zijn.
- [ ] Eén remote wijziging veroorzaakt maximaal één benodigde contentdownload.
- [ ] Dirty lokale drafts worden nooit stil overschreven.
- [ ] Offline gecachte documenten blijven beschikbaar.
- [ ] Zoekresultaten en diagnostics worden correct bijgewerkt.
- [ ] IndexedDB-migratie verwijdert geen drafts, history of sessies.
- [ ] Netwerkgedrag is aantoonbaar met geautomatiseerde tests.
- [ ] De privacykeuze voor lokale contentopslag is expliciet vastgelegd.

---

# 12. Prestatiemetrics

Voeg minimaal toe:

```text
workspace_activate_ms
manifest_load_ms
remote_reconcile_ms
drive_metadata_request_count
drive_content_download_count
drive_content_download_bytes
index_documents_processed
cache_hit_count
cache_miss_count
```

Doel voor een warme start zonder wijzigingen:

```text
drive_content_download_count = 0
```

---

# 13. Risico’s

## Verouderde metadata

Gebruik alleen een mirror-hit wanneer de vergeleken remote metadata voldoende actueel is.

## Renames

Sla stabiele Drive file IDs op. Alleen paden bewaren maakt een rename ononderscheidbaar van delete plus create.

## Cache eviction

Mobiele browsers kunnen IndexedDB verwijderen. Cold start moet altijd blijven werken.

## Dubbele contentstores

Mirror, zoekcache, drafts en history kunnen dezelfde content meerdere keren opslaan. Overweeg later één centrale documentcache.

## Diagnostics

Zelfs zonder netwerkdownloads kan een volledige diagnostics-scan duur blijven. Maak diagnostics uiteindelijk revision-gebaseerd en incrementeel.

---

# 14. Oorspronkelijk voorstel

> Superseded: zie ADR 0004 en het gekoppelde implementatieplan voor het definitieve besluit na de grilling-sessie.

Geen volledige rewrite als eerste stap.

Start met:

1. revision-aware gebruik van de bestaande Drive mirror;
2. metadata-first external-change-checks;
3. minder agressieve en gededupliceerde polling;
4. incrementele zoekindexering.

Voeg daarna een persistent workspace-manifest en de Drive Changes API toe wanneer ook de recursieve metadata-scan moet verdwijnen.

De bestaande architectuur kan behouden blijven. De belangrijkste verandering is dat lokale opslag een gecontroleerde warme cache wordt, in plaats van alleen een offline fallback en zoekbron.
