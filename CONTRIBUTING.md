# Contributing

Thanks for taking a look.

## Before opening a pull request

- **Keep every identifier a placeholder.** Account ids, endpoint usernames,
  phone numbers, hostnames, call UUIDs and credentials in this repository are
  deliberately fake. Please keep it that way.
- **Do not commit a `.env`.** Only `.env.example`, with empty values.
- **Say what you tested.** "Placed an outbound call, heard two-way audio, saw
  the log land on the record" is worth more than a description of the diff.

## Running it

See the setup guide in `docs/`. You need a Vobiz account with a number and
balance — every test places a real call and bills it.

## Reporting a bug

Open an issue with the backend log around the failure. The `DialBLegUUID` field
on the dial result is the single most useful line in this stack: present means
the call connected, empty means no B leg was ever created, whatever the UI
showed.

For anything security-related, see [SECURITY.md](SECURITY.md) instead.
