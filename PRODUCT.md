# @corbits/mailbox — Product

## What it is

A native Interchange mailbox for **human** principals. The package gives a
host a Postgres-backed `@intx/mailbox` `MailboxStore` and the HTTP routes a
host UI needs to list, read, send, and file that mailbox. Backend only —
this package ships no UI.

Typical callers: an Interchange hub that already has `public.tenant` /
`public.principal`, a Hono app, and a mail transport.

## Why it exists

Interchange `session_mail` is the message as delivered to an agent run. A
person needs a durable inbox of their own: IMAP-shaped folders and flags,
RFC 5322 frames, search and threading that match Interchange's mailbox
vocabulary, and a live nudge when something lands. That store and those
routes do not belong in every host, and they must not invent a second mail
model beside `@intx/mailbox`.

This package owns the native store, the `/me/inbox*` surface, and the
write/persist seams that land frames through that store. The host owns
auth, the wire, and the UI.

## Who it is for

Interchange hub operators who already have:

- A tenant app and a Postgres database with Interchange `tenant` /
  `principal` tables in the same database as this package's `mailbox`
  schema.
- A Hono app (auth already applied, if the host wants it).
- A mail transport that can send a built RFC 5322 message, and optionally
  persist its own copy of a frame.

## What users can do

- Mount `/me/inbox` so a signed-in principal can list INBOX / Sent /
  Archive / Trash, thread by References, mark read/unread, archive, trash,
  restore, and watch a live SSE stream.
- Send from the caller's mailbox: this package builds the frame, files a
  `Sent` copy, and hands the bytes to the host's `deliver`.
- Write a durable message into a principal's folder
  (`writeMailboxMessage`) or fan ingress items in
  (`deliverInboxItems`, deduped on source + external id).
- Wrap the host's own mail persist so every addressed principal also gets
  an INBOX copy (`createMailboxPersist`), without either write taking the
  other down.
- Offboard: deleting a tenant or principal cascades mailbox rows; hosts
  that soft-delete can call `purgeTenantMailbox` /
  `purgePrincipalMailbox`.

## Non-goals

- Not a UI. Rendering lives in the host (or `@corbits/ui`).
- Not a mail transport, SMTP/IMAP server, or Gmail connector. `deliver`
  and ingress adapters are host code.
- Not agent `session_mail`. This is the human mailbox; agent delivery
  stays on Interchange.
- Not a triage product. Priority, classification, status, and assignee
  were a pre-native management layer and are gone. Flags (`\Seen`) and
  folders (INBOX / Sent / Archive / Trash) are the filing model.
- Not a multi-replica event log. SSE is a best-effort nudge to refetch.

## Goals

1. One native `MailboxStore` over Postgres so vendored
   `executeSearch` / `executeThread` run unmodified.
2. Every write goes through `NativeMailboxStore.append` (uid and modseq
   always set). There is no second, uid-less insert path.
3. Host-owned auth, transport, and persistence of the *upstream* copy.
4. Control-plane FKs so a mailbox row can only belong to a tenant and
   principal the host already knows.
5. Dual-write independence on the transport persist seam: a failed
   upstream persist still attempts the mailbox copy; a failed mailbox
   write never rejects a persist the transport already completed.

## License

LGPL-2.1-only.
