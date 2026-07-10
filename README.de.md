# ioBroker BACnet Flex

Deutsche Dokumentation fuer den ioBroker Adapter `bacnet-flex`.

English documentation: [README.md](README.md)

## Ueberblick

BACnet Flex ist ein ioBroker Adapter fuer BACnet/IP Client- und Server-Betrieb, BACnet MS/TP ueber einen externen BACnet/IP-zu-MS/TP-Router und BACnet/SC Client-Zugriff ueber einen Secure-Connect-Hub.

## Unterstuetzte Transporte

| Transport | Unterstuetzung | Hinweise |
| --- | --- | --- |
| BACnet/IP | Client und Server | UDP, Standard-Port `47808`. |
| BACnet MS/TP | Ueber externen Router/Gateway | Der Adapter spricht BACnet/IP zu einem Router, der auf RS-485 MS/TP umsetzt. Direkter serieller MS/TP-Token-Passing-Betrieb ist in diesem JavaScript-Adapter nicht implementiert. |
| BACnet/SC | Client Lesen/Schreiben | Verbindung zu einem BACnet/SC Hub, z.B. `wss://192.168.2.50:47809`. Server-Modus ist fuer BACnet/SC noch nicht verfuegbar. |

## Anforderungen

- ioBroker mit js-controller 6 oder neuer.
- Node.js 22 oder neuer.
- BACnet/IP-Netzwerkzugriff fuer BACnet/IP und MS/TP-Router-Modus.
- Fuer MS/TP: konfigurierter BACnet/IP-zu-MS/TP-Router am RS-485-Bus.
- Fuer BACnet/SC: erreichbarer BACnet/SC-Hub und passende TLS-/Zertifikatskonfiguration auf dem Host.

## Client-Modus

Fuer ein einzelnes BACnet/IP-Geraet:

- `clientTargetIp`: IP-Adresse des BACnet/IP-Geraets oder des MS/TP-Routerziels
- `clientTargetDeviceId`: optionale BACnet Device-ID
- `clientObjectsJson`: Objekte, die gelesen werden sollen

Beispiel:

```json
[
  { "id": "temp", "name": "Supply temperature", "type": "analogValue", "instance": 1, "write": false },
  { "id": "enable", "name": "Enable", "type": "binaryValue", "instance": 2, "write": true }
]
```

Client-Werte entstehen unter:

```text
bacnet-flex.0.client.<device>.<object>
```

Schreibbare BACnet-Objekte erhalten zusaetzlich einen `_set` Datenpunkt. Schreibzugriffe werden als `WriteProperty presentValue` gesendet.

## BACnet MS/TP

MS/TP ist ein serieller RS-485-Feldbus mit Token Passing. Dieser Adapter implementiert kein direktes serielles MS/TP-Framing. Fuer MS/TP wird ein externer BACnet/IP-zu-MS/TP-Router oder ein Gateway benoetigt.

Typischer Ablauf:

1. MS/TP-Geraete an den Router anschliessen.
2. Baudrate, MAC-Adresse, Max Master und Netzwerknummer im Router setzen.
3. Router-IP in `MS/TP router IP` eintragen.
4. Objekte manuell konfigurieren oder Discovery verwenden, wenn der Router die Geraete passend weiterleitet.

## BACnet/SC

BACnet/SC verbindet sich als Thin Client zu einem Secure-Connect-Hub.

Wichtige Einstellungen:

- `Transport`: `BACnet/SC client`
- `BACnet/SC hub URL`: z.B. `wss://192.168.2.50:47809`
- `BACnet/SC device UUID`: optionale persistente lokale UUID

BACnet/SC unterstuetzt aktuell Client-Lesen, Client-Schreiben und Who-Is/I-Am-Erfassung. Server-Modus ist in BACnet/SC deaktiviert.

## Server-Modus

Der Server-Modus ist fuer BACnet/IP verfuegbar. Mit `serverStatesPattern` werden ioBroker States ausgewaehlt. Zahlen werden als `analogValue`, Booleans als `binaryValue` und andere Werte als `characterStringValue` veroeffentlicht.

Der Server beantwortet:

- `Who-Is`
- `ReadProperty`
- `ReadPropertyMultiple`
- `WriteProperty` fuer `presentValue` auf schreibbaren Objekten

Manuelle Serverpunkte koennen in der Tabelle `serverPoints` angelegt werden. Ohne `stateId` erzeugt der Adapter interne States unter:

```text
bacnet-flex.0.server.points.<instance>
```

Mit `stateId` wird ein vorhandener ioBroker State als BACnet-Objekt veroeffentlicht.

## Fehlerbehebung

### Keine BACnet/IP-Geraete gefunden

- UDP-Port `47808` in Firewall pruefen.
- Broadcast-Adresse des Subnetzes korrekt setzen.
- Ggf. konkrete lokale IP statt `0.0.0.0` als Bind-Interface verwenden.

### MS/TP-Geraete sind nicht sichtbar

- Router-Konfiguration pruefen: Baudrate, MAC-Adresse, Max Master und Netzwerknummer.
- BACnet/IP-Seite des Routers pruefen.
- Manche Router leiten Discovery nicht vollstaendig weiter; dann Objekte manuell konfigurieren.

### BACnet/SC verbindet nicht

- Hub-URL muss mit `wss://` beginnen.
- TLS-Vertrauen und Zertifikate auf dem Host pruefen.
- Pruefen, ob der Secure-Connect-Hub diesen Client akzeptiert.

## Lizenz

MIT
