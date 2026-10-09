# Breezy spaces — design

A device joins any number of spaces, each shared with different people, and keeps boards of its own that never sync. Spaces have a name everyone in them shares. Boards move between spaces. This extends [sync](2026-10-08-breezy-sync-design.md); records, merge, encryption and the server stay as they are.

## Model

A device has *groups*: **On this device**, which never syncs, and one per joined space. Each group is a `Store` with its own `SyncEngine`, exactly as now; the local group's store has no invite and its engine stays "local". A `Spaces` container holds them, finds a board's group by board id (ids are random 128-bit, so never shared between groups), and saves, syncs and reports each group separately.

Groups are listed On this device first, then spaces by name, then id. On this device is hidden when it is empty and the device is in a space.

## Name

- A space's name is a record whose id is the space id: `{"format": 1, "kind": "space", "name": "…"}`. It syncs and merges like any other record; a name changed on both sides takes incoming's.
- Apps without this design ignore unknown kinds and invite fields, so `format` stays 1.
- A space with no such record, as one started before this design, shows "Shared Space" until renamed.
- `Store` gains `name` and `rename(_:)`. A change to the name record reports the space id among the changed boards, which the container takes as a rename.

## Actions

| Action | Does |
|---|---|
| **New Space…** (replaces Start Syncing) | asks a name and the server, prefilled with the last server used; makes an empty space with its name record |
| **Join Space…** | takes a pasted link and adds its space as a group; nothing on the device is replaced. A link opened from outside asks "Join “Name” on host?". A space already joined is shown instead |
| **Rename Space…** | writes the name record |
| **Share Invite** | as now, per space; the link's JSON gains `name` |
| **Leave Space…** | asks "Leave “Name”? Its boards are removed from this device. Others in the space keep them."; closes its boards and deletes its store. The server is untouched; the link joins again |
| **Move to** a group | copies the board, its lanes and cards into the target group with new ids (order keys kept), waits for the target to be saved, then deletes the board from the source group. Asks first when the source is a space: "It is removed from “Name” on every device." An open board reopens from its new group, without undo history |
| **New Board** | in the group it is made from |
| **Delete Board** | as now; the message names the space: "It is deleted on every device in “Name”." |

- The first launch of the web app makes the sample board in On this device, unless it was opened from an invite link.
- A space answering 401 stays listed with "Not in this space any more"; Leave removes it.

## Storage

| | Mac | Web |
|---|---|---|
| On this device | `~/Library/Application Support/Breezy/Spaces/local.json` | IndexedDB key `local` |
| A space | `Spaces/<space id>.json` | key `space:<space id>` |
| Last server used | `UserDefaults` | key `server` |

- Files stay mode 0600, written atomically off the main thread; each group has its own saver.
- Leaving deletes the group's file or key.
- **Migration**, once at launch: the old `space.json` or `space` key becomes the space it names, or On this device when it has no invite; then the old file or key is removed. A device that synced keeps its whole state, cursor and epoch included, so nothing is pulled again.

## Sync

Each space's engine runs its own cycles at the same moments as now: a board of that space opening, the app returning to the foreground (every space), every 5 s while a window or the web app is visible (every space), 1 s after a local change in that space. A failing space backs off alone.

## Web app

- The board list has a section per group. A space's header shows its name and first status line and has a ⋯ with Rename Space, Share Invite and Leave Space. Each section ends with a New Board row; the button below the list goes.
- A board row's ⋯ gains Move to…, a sheet listing the other groups.
- The top ⋯ menu has New Space and Join Space; Share Invite leaves it. On a board it shows that board's space status; on the list, only "Boards can’t be saved on this device" when that applies.

## Mac app

- The Boards window becomes a source list: a group row per group, boards beneath. `+` adds a board to the selected group (On this device when nothing is selected). The status bar shows the selected group's status.
- A board row's context menu: Move to ▸ (the other groups) and Delete. A space row's: Rename Space…, Share Invite, Leave Space….
- The Breezy menu has New Space… and Join Space…, then Share Invite, Rename Space… and Leave Space… for the space of the key board window or, failing that, the Boards window's selection; then each space's status lines, prefixed by its name.
- A board window's title gains its space: "Plans — Work". Window restoration still goes by board id.

## Testing

- **Unit, both languages:** the name record (default, rename, merge, ignored by board listing); invite with and without `name`; migration of a local and a synced store; Move (fresh ids, order kept, target saved before the source deletes, source deletion pending); Leave.
- **Convergence:** the existing four-device test, with two spaces on one fake server and a device in both moving boards between them; each space ends identical on its devices.
- **By hand:** the Mac and the phone in two spaces, one shared with each; a board moved from On this device into a space appears on the other device; leaving a space leaves the other untouched.

## Out of scope

Changing a space's server, merging two spaces, per-person access, nesting, ordering groups by hand.
