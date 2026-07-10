# ioBroker BACnet Flex

BACnet adapter for ioBroker with BACnet/IP client and server modes, BACnet MS/TP access through an external BACnet/IP-to-MS/TP router, and BACnet/SC client access through a Secure Connect hub.

German documentation is available here: [README.de.md](README.de.md).

## Supported transports

| Transport | Support | Notes |
| --- | --- | --- |
| BACnet/IP | Client and server | Uses UDP, default port `47808`. |
| BACnet MS/TP | Via external router/gateway | The adapter communicates BACnet/IP to a router that bridges to RS-485 MS/TP. Direct serial token-passing MS/TP is not implemented in this JavaScript adapter. |
| BACnet/SC | Client reads/writes | Uses a BACnet/SC hub URL such as `wss://192.168.2.50:47809`. Server mode is not available for BACnet/SC yet. |

## Requirements

- ioBroker with js-controller 6 or newer.
- Node.js 22 or newer.
- BACnet/IP network access for BACnet/IP and MS/TP-router mode.
- For MS/TP: a configured BACnet/IP-to-MS/TP router or gateway connected to the RS-485 bus.
- For BACnet/SC: a reachable BACnet/SC hub and valid WebSocket/TLS trust configuration on the host.

## Client mode

For one BACnet/IP device, configure:

- `clientTargetIp`: IP address of the BACnet/IP device or MS/TP router target
- `clientTargetDeviceId`: optional BACnet device ID
- `clientObjectsJson`: objects to read from that target

Example for `clientObjectsJson`:

```json
[
  { "id": "temp", "name": "Supply temperature", "type": "analogValue", "instance": 1, "write": false },
  { "id": "enable", "name": "Enable", "type": "binaryValue", "instance": 2, "write": true }
]
```

For multiple BACnet/IP devices, configure `clientDevicesJson` as an advanced array:

```json
[
  {
    "id": "ahu1",
    "name": "AHU 1",
    "address": "192.168.2.50",
    "deviceId": 12345,
    "objects": [
      { "id": "temp", "name": "Supply temperature", "type": "analogValue", "instance": 1, "write": false },
      { "id": "enable", "name": "Enable", "type": "binaryValue", "instance": 2, "write": true }
    ]
  }
]
```

Client values are created below:

```text
bacnet-flex.0.client.<device>.<object>
```

Writable BACnet objects also get a `_set` state. Writes are sent as `WriteProperty presentValue`.

## BACnet MS/TP

MS/TP is a serial RS-485 field bus with token passing. This adapter does not implement direct serial MS/TP framing. Use an external BACnet/IP-to-MS/TP router or gateway and select transport `BACnet MS/TP via BACnet/IP router`.

Typical setup:

1. Connect the MS/TP devices to a BACnet/IP-to-MS/TP router.
2. Configure baud rate, MAC address, max master and network number on the router.
3. Put the router IP into `MS/TP router IP`.
4. Configure the target objects manually or use discovery if the router exposes the devices correctly.

## BACnet/SC

BACnet/SC mode connects as a BACnet/SC thin client to a Secure Connect hub.

Configure:

- `Transport`: `BACnet/SC client`
- `BACnet/SC hub URL`: for example `wss://192.168.2.50:47809`
- `BACnet/SC device UUID`: optional persistent local UUID

BACnet/SC mode currently supports client reads, writes and Who-Is/I-Am collection. Server mode is disabled in BACnet/SC mode.

## Server mode

Server mode is available for BACnet/IP transport. Configure `serverStatesPattern` to select ioBroker states. Number states are published as `analogValue`, boolean states as `binaryValue`, and all other states as `characterStringValue`.

The BACnet server answers:

- `Who-Is`
- `ReadProperty`
- `ReadPropertyMultiple`
- `WriteProperty` for `presentValue` on writable published objects

Additional manual server data points can be configured in the Admin table `serverPoints`. Each row defines the BACnet object type and instance that a BACnet client can read from this adapter.

If a row has no `stateId`, the adapter creates an ioBroker state below:

```text
bacnet-flex.0.server.points.<instance>
```

If `stateId` is set, that existing ioBroker state is exposed as the BACnet object. Set `writable` to allow BACnet `WriteProperty presentValue` writes for that row.

## Troubleshooting

### No BACnet/IP devices found

- Check local firewall rules for UDP port `47808`.
- Set the correct broadcast address for the subnet.
- Try a specific local bind interface instead of `0.0.0.0`.

### MS/TP devices are not visible

- Check the router configuration first: baud rate, MAC address, max master and network number.
- Verify that the BACnet/IP side of the router is reachable.
- Some routers do not forward all discovery broadcasts; configure objects manually if needed.

### BACnet/SC does not connect

- The hub URL must start with `wss://`.
- Check TLS trust and certificates on the host.
- Check that the Secure Connect hub accepts this client.

## Changelog

### 0.1.0

- Initial BACnet Flex adapter with BACnet/IP client/server, MS/TP router mode and BACnet/SC client mode.

## License

MIT

Copyright (c) 2026 TheBam1990
