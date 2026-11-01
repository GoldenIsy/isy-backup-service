# Local Backup Control Protocol v1

This directory owns the strict Unix-socket payloads exchanged between one Isy
Backup Service instance and its co-located IsyReport installation agent. The
socket is local-only and does not use or expose SaaS credentials.

`protocol.schema.json` freezes the local observation, operation summary,
receipt page and command lifecycle envelopes. `payload-fixtures.json` supplies
accepted and rejected parity vectors. Public SaaS payloads are deliberately
smaller projections owned by SaaS-IsyReport; the installation agent may copy
only fields admitted by that public contract.

Unknown fields and command actions fail closed. Commands contain only configured
logical identifiers and immutable digests. URLs, paths, credentials, arbitrary
arguments, environment variables, raw output and customer content are outside
the protocol.
