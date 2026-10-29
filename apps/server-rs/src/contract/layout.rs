//! Room layout v1 (ADR 0021), mirroring `packages/shared/src/layout.ts` and the preset ids of
//! `room-ownership.ts`. Two parsers share every rule: [`RoomLayout::parse_input`] is
//! `RoomLayoutInputSchema` (a client's `layout-set`: unknown keys refused at both levels),
//! [`RoomLayout::parse`] is `RoomLayoutSchema` (the store, presets, snapshots: unknown keys stripped).
//!
//! The server stores `JSON.stringify(parsed)` and compares two of them to spot a no-op edit, so a
//! [`RoomLayout`] has one canonical JSON form ([`RoomLayout::to_json`]): the TS key order, `variant`
//! left out when absent.

use super::constants::{FLOOR_CELLS, MAX_DOORS, MAX_FURNITURE, SEAT_COUNT};
use super::ids::RoomId;
use super::room::FloorCell;
use super::{Invalid, Obj, parse_json};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
use validator::{Validate, ValidationError};

/// The way a piece faces, i.e. where a sitter looks. ne/nw face the TV corner, se/sw the camera.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Facing {
    Ne,
    Nw,
    Se,
    Sw,
}

/// `RoomMoodSchema`: the room's lighting mood (OME-1499). A layout without one, as every layout saved before it, is `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mood {
    #[default]
    None,
    Warm,
    Cool,
    Night,
}

pub const FACINGS: [Facing; 4] = [Facing::Ne, Facing::Nw, Facing::Se, Facing::Sw];
const CAMERA: &[Facing] = &[Facing::Se, Facing::Sw];
/// One sprite, so one canonical facing.
const FIXED: &[Facing] = &[Facing::Se];
const ON_FLOOR: &[Facing] = &[Facing::Ne, Facing::Nw];

/// Every piece a layout may hold (the keys of `FURNITURE` in layout.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Armchair,
    Tv,
    Lamp,
    Plant,
    Rug,
    Sofa,
    Couch,
    Wingback,
    Beanbag,
    Sidetable,
    Arclamp,
    Monstera,
    Popcorn,
    Bookshelf,
    Runner,
    Frame,
    Floorcushion,
    Bench,
    Turntable,
    Speaker,
    Cat,
    Wallshelf,
    Garland,
    Coffeetable,
    Pouf,
    Neonsign,
    Aquarium,
    Arcade,
    Wallclock,
    Door,
    Hammock,
    Stool,
    Barcounter,
    Piano,
    Fireplace,
    Pad,
    // Theatre set (OME-1625 / OME-1639).
    Theatrerow,
    Curtain,
    Bigscreen,
    Aislelight,
    Carpet,
    // Dank Dungeon (OME-1670 / OME-1672).
    Bed,
    Whirlpool,
    Mirror,
    Minibar,
    Desk,
    Washbasin,
    Partition,
}

impl Kind {
    /// `isScreen` (ADR 0056): a layout holds exactly one screen, a `tv` or a `bigscreen`.
    pub const fn is_screen(self) -> bool {
        matches!(self, Self::Tv | Self::Bigscreen)
    }
}

pub const KINDS: [Kind; 48] = [
    Kind::Armchair,
    Kind::Tv,
    Kind::Lamp,
    Kind::Plant,
    Kind::Rug,
    Kind::Sofa,
    Kind::Couch,
    Kind::Wingback,
    Kind::Beanbag,
    Kind::Sidetable,
    Kind::Arclamp,
    Kind::Monstera,
    Kind::Popcorn,
    Kind::Bookshelf,
    Kind::Runner,
    Kind::Frame,
    Kind::Floorcushion,
    Kind::Bench,
    Kind::Turntable,
    Kind::Speaker,
    Kind::Cat,
    Kind::Wallshelf,
    Kind::Garland,
    Kind::Coffeetable,
    Kind::Pouf,
    Kind::Neonsign,
    Kind::Aquarium,
    Kind::Arcade,
    Kind::Wallclock,
    Kind::Door,
    Kind::Hammock,
    Kind::Stool,
    Kind::Barcounter,
    Kind::Piano,
    Kind::Fireplace,
    Kind::Pad,
    Kind::Theatrerow,
    Kind::Curtain,
    Kind::Bigscreen,
    Kind::Aislelight,
    Kind::Carpet,
    Kind::Bed,
    Kind::Whirlpool,
    Kind::Mirror,
    Kind::Minibar,
    Kind::Desk,
    Kind::Washbasin,
    Kind::Partition,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    /// Drawn with the floor, walkable, may lie under objects.
    Floor,
    /// Solid, depth-sorted.
    Object,
    /// Hangs on a wall.
    Wall,
}

/// `LIE_STYLES` (OME-1773): how a member lies on a piece.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LieStyle {
    Lie,
    Curl,
}

/// One row of `FURNITURE`.
#[derive(Debug, Clone, Copy)]
pub struct Spec {
    pub layer: Layer,
    pub facings: &'static [Facing],
    /// Footprint when facing ne or sw; nw and se swap it. Wall pieces take no floor cells (0×0).
    pub cols: u8,
    pub rows: u8,
    /// Every footprint cell is a seat facing the piece's way.
    pub seats: bool,
    /// Colour or artwork variants; variant 0 is the default.
    pub variants: u32,
    /// Facing sw it stands on row 0 (right wall), facing se on col 0 (left wall).
    pub wall_backed: bool,
    /// A member may lie on it (`lie`), blocking its seats (OME-1773).
    pub lie: Option<LieStyle>,
}

impl Spec {
    const fn new(layer: Layer, facings: &'static [Facing], cols: u8, rows: u8) -> Self {
        Self {
            layer,
            facings,
            cols,
            rows,
            seats: false,
            variants: 1,
            wall_backed: false,
            lie: None,
        }
    }
    const fn lie(mut self, style: LieStyle) -> Self {
        self.lie = Some(style);
        self
    }
    const fn seated(mut self) -> Self {
        self.seats = true;
        self
    }
    const fn variants(mut self, n: u32) -> Self {
        self.variants = n;
        self
    }
    const fn backed(mut self) -> Self {
        self.wall_backed = true;
        self
    }
}

const ALL: &[Facing] = &FACINGS;

pub const fn spec(kind: Kind) -> Spec {
    use Layer::{Floor, Object, Wall};
    match kind {
        Kind::Armchair => Spec::new(Object, ALL, 1, 1).seated(),
        Kind::Tv => Spec::new(Object, FIXED, 1, 1),
        Kind::Lamp | Kind::Plant => Spec::new(Object, FIXED, 1, 1).variants(3),
        Kind::Rug => Spec::new(Floor, FIXED, 7, 7).variants(3),
        Kind::Sofa => Spec::new(Object, ALL, 2, 1).seated().variants(4).lie(LieStyle::Lie),
        Kind::Couch => Spec::new(Object, ALL, 2, 1).seated().variants(2).lie(LieStyle::Lie),
        Kind::Wingback => Spec::new(Object, ALL, 1, 1).seated(),
        Kind::Beanbag | Kind::Pouf => Spec::new(Object, ALL, 1, 1).seated().variants(4),
        Kind::Floorcushion => Spec::new(Object, ALL, 1, 1).seated().variants(2),
        Kind::Arclamp => Spec::new(Object, CAMERA, 1, 1).variants(3),
        Kind::Sidetable | Kind::Popcorn | Kind::Turntable | Kind::Coffeetable | Kind::Aquarium | Kind::Arcade => {
            Spec::new(Object, CAMERA, 1, 1)
        }
        Kind::Monstera => Spec::new(Object, CAMERA, 1, 1).variants(4),
        Kind::Speaker => Spec::new(Object, CAMERA, 1, 1).variants(2),
        // A non-seat, so seat indices don't move (OME-1773).
        Kind::Cat => Spec::new(Object, CAMERA, 1, 1).variants(2).lie(LieStyle::Curl),
        Kind::Bookshelf => Spec::new(Object, CAMERA, 2, 1).variants(3).backed(),
        Kind::Runner => Spec::new(Floor, ON_FLOOR, 3, 2).variants(4),
        Kind::Frame | Kind::Garland => Spec::new(Wall, CAMERA, 0, 0).variants(4),
        Kind::Neonsign => Spec::new(Wall, CAMERA, 0, 0).variants(2),
        Kind::Bench => Spec::new(Object, ALL, 2, 1).seated().variants(2),
        Kind::Wallshelf => Spec::new(Wall, CAMERA, 0, 0).variants(3),
        Kind::Wallclock => Spec::new(Wall, CAMERA, 0, 0),
        Kind::Door => Spec::new(Object, CAMERA, 1, 1).variants(2).backed(),
        Kind::Hammock => Spec::new(Object, ALL, 2, 1).seated(),
        Kind::Stool => Spec::new(Object, ALL, 1, 1).seated().variants(4),
        Kind::Barcounter => Spec::new(Object, CAMERA, 2, 1),
        Kind::Piano => Spec::new(Object, CAMERA, 2, 1).variants(2),
        Kind::Fireplace => Spec::new(Object, CAMERA, 1, 1).backed(),
        Kind::Pad => Spec::new(Floor, FIXED, 1, 1).variants(2),
        // The riser step is the variant: 0 floor, 1 one step, 2 two steps.
        Kind::Theatrerow => Spec::new(Object, ON_FLOOR, 2, 1).seated().variants(3),
        Kind::Curtain => Spec::new(Wall, CAMERA, 0, 0),
        Kind::Bigscreen => Spec::new(Object, FIXED, 1, 1),
        Kind::Aislelight => Spec::new(Floor, ON_FLOOR, 1, 1),
        Kind::Carpet => Spec::new(Floor, FIXED, 2, 2),
        // A queen bed (OME-1982): 2×2, two sleepers side by side on its first row.
        Kind::Bed => Spec::new(Object, ALL, 2, 2).seated(),
        Kind::Whirlpool => Spec::new(Object, ALL, 2, 1).seated(),
        Kind::Mirror => Spec::new(Wall, CAMERA, 0, 0),
        Kind::Minibar | Kind::Desk => Spec::new(Object, CAMERA, 1, 1),
        Kind::Washbasin => Spec::new(Object, CAMERA, 1, 1).backed(),
        // The facing picks the axis; 0 solid, 1 glass (OME-1958).
        Kind::Partition => Spec::new(Object, CAMERA, 1, 1).variants(2),
    }
}

/// Wall segments with a window, poster or sconce (the same on both walls); frames need a plain one.
pub const WALL_FIXTURE_SEGMENTS: [u32; 3] = [5, 6, 8];

/// A placed piece. `variant` absent means 0. `target` is a door's room (ADR 0054), set on a door and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Furniture {
    pub kind: Kind,
    pub col: u8,
    pub row: u8,
    pub facing: Facing,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<RoomId>,
}

impl Furniture {
    pub const fn new(kind: Kind, col: u8, row: u8, facing: Facing) -> Self {
        Self {
            kind,
            col,
            row,
            facing,
            variant: None,
            target: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Seat {
    pub col: u32,
    pub row: u32,
    pub facing: Facing,
}

const fn turned(f: &Furniture) -> bool {
    matches!(f.facing, Facing::Nw | Facing::Se)
}

/// Floor cells `(col, row)` a piece covers, from its anchor cell toward +col and +row, cols before rows.
pub fn footprint_cells(f: &Furniture) -> Vec<(u32, u32)> {
    let s = spec(f.kind);
    let (cols, rows) = if turned(f) { (s.rows, s.cols) } else { (s.cols, s.rows) };
    let (col, row) = (u32::from(f.col), u32::from(f.row));
    (0..u32::from(cols))
        .flat_map(|c| (0..u32::from(rows)).map(move |r| (col + c, row + r)))
        .collect()
}

/// Seat `i` is the `i`-th seat cell across seat-giving pieces, in `furniture` order (ADR 0021). A piece seats
/// along its first row only (ADR 0057).
pub fn layout_seats(furniture: &[Furniture]) -> Vec<Seat> {
    let mut seats = Vec::new();
    for f in furniture.iter().filter(|f| spec(f.kind).seats) {
        let first_row = |&(col, row): &(u32, u32)| {
            if turned(f) {
                col == u32::from(f.col)
            } else {
                row == u32::from(f.row)
            }
        };
        seats.extend(footprint_cells(f).into_iter().filter(first_row).map(|(col, row)| Seat {
            col,
            row,
            facing: f.facing,
        }));
    }
    seats
}

/// The seat indices piece `piece` gives (OME-1691): empty for a piece without seats, `None` past the last piece.
pub fn piece_seats(furniture: &[Furniture], piece: usize) -> Option<std::ops::Range<usize>> {
    let f = furniture.get(piece)?;
    let cells = |f: &Furniture| if spec(f.kind).seats { footprint_cells(f).len() } else { 0 };
    let before = furniture.iter().take(piece).fold(0usize, |n, f| n.saturating_add(cells(f)));
    Some(before..before.saturating_add(cells(f)))
}

/// Wall pieces hang on the right wall at (col, 0) facing sw, on the left wall at (0, row) facing se.
fn wall_segment(f: &Furniture) -> (bool, u32) {
    if f.facing == Facing::Sw {
        (true, u32::from(f.col))
    } else {
        (false, u32::from(f.row))
    }
}

fn on_its_wall(f: &Furniture, s: &Spec) -> bool {
    if s.layer != Layer::Wall && !s.wall_backed {
        return true;
    }
    let off = if f.facing == Facing::Sw { f.row != 0 } else { f.col != 0 };
    if off {
        return false;
    }
    s.layer != Layer::Wall || !WALL_FIXTURE_SEGMENTS.contains(&wall_segment(f).1)
}

/// One piece's rules on top of its fields (the `v.check`s of `furniture` in layout.ts).
fn piece_ok(f: &Furniture) -> bool {
    let s = spec(f.kind);
    let floor = FLOOR_CELLS as u32;
    s.facings.contains(&f.facing)
        && f.variant.unwrap_or(0) < s.variants
        && footprint_cells(f).iter().all(|&(c, r)| c < floor && r < floor)
        && on_its_wall(f, &s)
        && (f.kind == Kind::Door) == f.target.is_some()
}

/// True if no two pieces of `layer` share a cell (wall pieces: a wall segment).
fn disjoint(furniture: &[Furniture], layer: Layer) -> bool {
    let mut used = HashSet::new();
    for f in furniture.iter().filter(|f| spec(f.kind).layer == layer) {
        let keys: Vec<(u32, u32)> = if layer == Layer::Wall {
            let (right, i) = wall_segment(f);
            vec![(u32::from(right), i)]
        } else {
            footprint_cells(f)
        };
        if !keys.into_iter().all(|k| used.insert(k)) {
            return false;
        }
    }
    true
}

/// The layout's rules on top of its pieces' (ADR 0021 §3).
fn layout_ok(furniture: &[Furniture]) -> bool {
    furniture.len() <= MAX_FURNITURE
        && furniture.iter().filter(|f| f.kind.is_screen()).count() == 1
        && furniture.iter().filter(|f| f.kind == Kind::Door).count() <= MAX_DOORS
        && matches!(furniture.iter().filter(|f| f.kind == Kind::Pad).count(), 0 | 2)
        && layout_seats(furniture).len() == SEAT_COUNT
        && disjoint(furniture, Layer::Object)
        && disjoint(furniture, Layer::Floor)
        && disjoint(furniture, Layer::Wall)
}

fn refuse(code: &'static str) -> Result<(), ValidationError> {
    Err(ValidationError::new(code))
}

/// What `check_piece` and `check_layout` need from a wire struct.
trait Wire {
    fn furniture(&self) -> Furniture;
}

/// validator passes `&&Self` to a schema function.
impl<T: Wire> Wire for &T {
    fn furniture(&self) -> Furniture {
        (**self).furniture()
    }
}

fn check_piece<P: Wire>(p: &P) -> Result<(), ValidationError> {
    if piece_ok(&p.furniture()) { Ok(()) } else { refuse("piece") }
}

/// `variant` and `target` are optional but not nullable: `null` is refused where `Option` would read it as absent.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// The strict and the stripping wire shapes differ only in `deny_unknown_fields`.
macro_rules! wire {
    ($piece:ident, $layout:ident $(, $deny:meta)?) => {
        // Serialize: validator's nested errors on a `Vec` want the items serializable.
        #[derive(Deserialize, Serialize, Validate)]
        $(#[$deny])?
        #[validate(schema(function = "check_piece"))]
        struct $piece {
            kind: Kind,
            // FLOOR_CELLS - 1, pinned by a test.
            #[validate(range(max = 9))]
            col: u8,
            #[validate(range(max = 9))]
            row: u8,
            facing: Facing,
            #[serde(default, deserialize_with = "present")]
            variant: Option<u32>,
            #[serde(default, deserialize_with = "present")]
            target: Option<RoomId>,
        }

        impl Wire for $piece {
            fn furniture(&self) -> Furniture {
                Furniture { kind: self.kind, col: self.col, row: self.row, facing: self.facing, variant: self.variant, target: self.target.clone() }
            }
        }

        #[derive(Deserialize, Validate)]
        $(#[$deny])?
        #[validate(schema(function = "check_layout"))]
        struct $layout {
            // MAX_FURNITURE, pinned by a test.
            #[validate(length(max = 32))]
            #[validate(nested)]
            furniture: Vec<Obj<$piece>>,
            #[serde(default, deserialize_with = "present")]
            mood: Option<Mood>,
            #[serde(default, deserialize_with = "present")]
            pairs: Option<bool>,
        }

        impl From<$layout> for RoomLayout {
            fn from(w: $layout) -> Self {
                Self { furniture: w.furniture.iter().map(|p| p.0.furniture()).collect(), mood: w.mood, pairs: w.pairs }
            }
        }
    };
}

wire!(LoosePiece, LooseLayout);
wire!(StrictPiece, StrictLayout, serde(deny_unknown_fields));

trait WireLayout {
    fn pieces(&self) -> Vec<Furniture>;
}
impl WireLayout for LooseLayout {
    fn pieces(&self) -> Vec<Furniture> {
        self.furniture.iter().map(|p| p.0.furniture()).collect()
    }
}
impl WireLayout for StrictLayout {
    fn pieces(&self) -> Vec<Furniture> {
        self.furniture.iter().map(|p| p.0.furniture()).collect()
    }
}

impl<T: WireLayout> WireLayout for &T {
    fn pieces(&self) -> Vec<Furniture> {
        (**self).pieces()
    }
}

fn check_layout<L: WireLayout>(l: &L) -> Result<(), ValidationError> {
    if layout_ok(&l.pieces()) { Ok(()) } else { refuse("layout") }
}

/// `RoomLayoutInputSchema` as a wire type, for a layout nested in another message (`layout-set`):
/// strict, validated like [`RoomLayout::parse_input`], duplicate keys refused.
#[derive(Deserialize)]
#[serde(transparent)]
pub struct RoomLayoutInput(StrictLayout);

impl Validate for RoomLayoutInput {
    fn validate(&self) -> Result<(), validator::ValidationErrors> {
        self.0.validate()
    }
}

impl From<RoomLayoutInput> for RoomLayout {
    fn from(w: RoomLayoutInput) -> Self {
        Self::from(w.0)
    }
}

/// A valid room layout. The only ways to get one are the two parsers and [`default_layout`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RoomLayout {
    furniture: Vec<Furniture>,
    /// As sent: an explicit "none" stays, absent stays absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    mood: Option<Mood>,
    /// The `/thrust` + `/bendover` pair is on (OME-1671). As sent, like `mood`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pairs: Option<bool>,
}

impl RoomLayout {
    /// `RoomLayoutSchema`: unknown keys are stripped.
    pub fn parse(raw: &[u8]) -> Result<Self, Invalid> {
        parse_json::<LooseLayout>(raw).map(Self::from)
    }

    /// `RoomLayoutInputSchema`: unknown keys are refused, on the layout and on each piece.
    pub fn parse_input(raw: &[u8]) -> Result<Self, Invalid> {
        parse_json::<StrictLayout>(raw).map(Self::from)
    }

    pub fn furniture(&self) -> &[Furniture] {
        &self.furniture
    }

    pub fn mood(&self) -> Mood {
        self.mood.unwrap_or_default()
    }

    pub fn pairs(&self) -> bool {
        self.pairs.unwrap_or_default()
    }

    pub fn seats(&self) -> Vec<Seat> {
        layout_seats(&self.furniture)
    }

    /// `hasDoorTo`: a door leads to `room`. A `layout-set` may not hold a door to its own room (ADR 0054).
    pub fn has_door_to(&self, room: &RoomId) -> bool {
        self.furniture.iter().any(|f| f.target.as_ref() == Some(room))
    }

    /// The floor cell in front of a door to `room` (OME-1556): a door faces sw on row 0 and se on col 0, so one step
    /// out from its wall. `None` without such a door or when a solid piece covers that cell.
    pub fn door_front(&self, room: &RoomId) -> Option<FloorCell> {
        self.furniture
            .iter()
            .filter(|f| f.kind == Kind::Door && f.target.as_ref() == Some(room))
            .find_map(|f| match f.facing {
                Facing::Se => FloorCell::new(u64::from(f.col) + 1, u64::from(f.row)),
                _ => FloorCell::new(u64::from(f.col), u64::from(f.row) + 1),
            })
            .filter(|&c| self.standable(c))
    }

    /// `isStandable`: no solid piece covers `cell`. Seats are solid, so they need `sit` (ADR 0053).
    pub fn standable(&self, cell: FloorCell) -> bool {
        let at = (u32::from(cell.x.get()), u32::from(cell.y.get()));
        !self
            .furniture
            .iter()
            .any(|f| spec(f.kind).layer == Layer::Object && footprint_cells(f).contains(&at))
    }

    /// `canTeleport`: `from` is one pad's cell, `cell` the other's, and nothing solid covers it (OME-1545).
    pub fn can_teleport(&self, from: Option<FloorCell>, cell: FloorCell) -> bool {
        let is_pad = |c: FloorCell| {
            self.furniture
                .iter()
                .any(|f| f.kind == Kind::Pad && u32::from(f.col) == u32::from(c.x.get()) && u32::from(f.row) == u32::from(c.y.get()))
        };
        from.is_some_and(|from| from != cell && is_pad(from)) && is_pad(cell) && self.standable(cell)
    }

    /// The canonical JSON: what the TS server's `JSON.stringify(parsed)` writes.
    pub fn to_json(&self) -> String {
        // Plain data of strings and small integers: serialization cannot fail.
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// `DOOR_CELL`: where people walk in, the floor's front corner; a layout change sends someone whose cell it covered here.
pub fn door_cell() -> Option<FloorCell> {
    let last = u64::try_from(FLOOR_CELLS - 1).ok()?;
    FloorCell::new(last, last)
}

/// Two rows of four armchairs facing the TV, split by an aisle (the pre-M4 `SEAT_CELLS`).
const DEFAULT_SEAT_CELLS: [(u8, u8); 8] = [(1, 5), (2, 4), (4, 2), (5, 1), (3, 7), (4, 6), (6, 4), (7, 3)];

/// Today's room as data: what the server seeds and what a client without a `layout` draws.
pub fn default_layout() -> RoomLayout {
    let chairs = DEFAULT_SEAT_CELLS
        .iter()
        .map(|&(col, row)| Furniture::new(Kind::Armchair, col, row, if col < row { Facing::Ne } else { Facing::Nw }));
    let furniture = [
        Furniture::new(Kind::Tv, 0, 0, Facing::Se),
        Furniture::new(Kind::Rug, 1, 1, Facing::Se),
    ]
    .into_iter()
    .chain(chairs)
    .chain([
        Furniture::new(Kind::Lamp, 9, 0, Facing::Se),
        Furniture::new(Kind::Plant, 0, 9, Facing::Se),
    ])
    .collect();
    RoomLayout {
        furniture,
        mood: None,
        pairs: None,
    }
}

/// The judged D1 room presets (room-ownership.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomPresetId {
    Classic,
    Cinema,
    Living,
    Lounge,
    Cafe,
    Bar,
    Empty,
    #[serde(rename = "dank-dungeon")]
    DankDungeon,
}

pub const ROOM_PRESET_IDS: [RoomPresetId; 8] = [
    RoomPresetId::Classic,
    RoomPresetId::Cinema,
    RoomPresetId::Living,
    RoomPresetId::Lounge,
    RoomPresetId::Cafe,
    RoomPresetId::Bar,
    RoomPresetId::Empty,
    RoomPresetId::DankDungeon,
];

/// Omitted preset means today's `DEFAULT_LAYOUT` (classic).
pub const DEFAULT_ROOM_PRESET: RoomPresetId = RoomPresetId::Classic;

impl RoomPresetId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::Cinema => "cinema",
            Self::Living => "living",
            Self::Lounge => "lounge",
            Self::Cafe => "cafe",
            Self::Bar => "bar",
            Self::Empty => "empty",
            Self::DankDungeon => "dank-dungeon",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn accepts(v: &Value) -> bool {
        RoomLayout::parse(v.to_string().as_bytes()).is_ok()
    }
    fn accepts_input(v: &Value) -> bool {
        RoomLayout::parse_input(v.to_string().as_bytes()).is_ok()
    }
    /// One piece alone through the piece rules (`FurnitureSchema`).
    fn piece_accepts(v: &Value) -> bool {
        parse_json::<LoosePiece>(v.to_string().as_bytes()).is_ok()
    }

    const TODAY: [[u8; 2]; 8] = [[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]];

    fn tv() -> Value {
        json!({"kind":"tv","col":0,"row":0,"facing":"se"})
    }
    fn chair(c: u8, r: u8) -> Value {
        json!({"kind":"armchair","col":c,"row":r,"facing": if c < r {"ne"} else {"nw"}})
    }
    fn chairs() -> Vec<Value> {
        TODAY.iter().map(|[c, r]| chair(*c, *r)).collect()
    }
    fn layout(furniture: Vec<Value>) -> Value {
        json!({ "furniture": furniture })
    }
    fn base(more: Vec<Value>) -> Value {
        let mut f = vec![tv()];
        f.extend(chairs());
        f.extend(more);
        layout(f)
    }
    fn p(kind: &str, col: u8, row: u8, facing: &str) -> Value {
        json!({"kind":kind,"col":col,"row":row,"facing":facing})
    }
    fn pv(kind: &str, col: u8, row: u8, facing: &str, variant: u8) -> Value {
        json!({"kind":kind,"col":col,"row":row,"facing":facing,"variant":variant})
    }
    /// The base layout in canonical key order (a `Value` sorts its keys, so text edits need this).
    fn canon_base() -> String {
        parse(&base(vec![])).to_json()
    }
    fn parse(v: &Value) -> RoomLayout {
        RoomLayout::parse(v.to_string().as_bytes()).unwrap()
    }
    fn seats_of(l: &RoomLayout) -> Vec<(u32, u32, Facing)> {
        l.seats().iter().map(|s| (s.col, s.row, s.facing)).collect()
    }

    fn catalogue_room() -> Value {
        layout(vec![
            tv(),
            pv("sofa", 1, 5, "ne", 1),
            p("sofa", 4, 5, "ne"),
            p("couch", 6, 1, "nw"),
            p("wingback", 8, 8, "sw"),
            pv("beanbag", 7, 7, "se", 1),
            pv("runner", 1, 7, "ne", 1),
            p("bookshelf", 3, 0, "sw"),
            p("frame", 2, 0, "sw"),
            pv("frame", 0, 3, "se", 1),
            p("sidetable", 3, 5, "se"),
            p("arclamp", 9, 0, "sw"),
            pv("monstera", 0, 9, "se", 1),
            p("popcorn", 9, 9, "sw"),
        ])
    }

    // packages/shared/test/layout-contract.test.ts (OME-1688 colourways)
    #[test]
    fn lamps_plants_and_shelves_take_their_r2_colourways() {
        for (kind, at, n) in [
            ("lamp", p("lamp", 9, 0, "se"), 3),
            ("plant", p("plant", 0, 9, "se"), 3),
            ("arclamp", p("arclamp", 9, 0, "sw"), 3),
            ("monstera", p("monstera", 0, 9, "se"), 4),
            ("bookshelf", p("bookshelf", 3, 0, "sw"), 3),
            ("wallshelf", p("wallshelf", 2, 0, "sw"), 3),
        ] {
            let mut last = at.clone();
            last["variant"] = json!(n - 1);
            let mut over = at;
            over["variant"] = json!(n);
            assert!(piece_accepts(&last), "{kind} variant {}", n - 1);
            assert!(!piece_accepts(&over), "{kind} variant {n}");
        }
    }

    // packages/shared/test/partition-contract.test.ts (OME-1958)
    #[test]
    fn a_partition_is_a_solid_one_cell_axis_piece_in_solid_or_glass() {
        let cell = |x: u64, y: u64| FloorCell::new(x, y).unwrap();
        for facing in ["se", "sw"] {
            for variant in [0, 1] {
                let l = parse(&base(vec![pv("partition", 5, 4, facing, variant)]));
                assert!(!l.standable(cell(5, 4)), "{facing} {variant} blocks its cell");
                for (x, y) in [(5, 3), (5, 5), (4, 4)] {
                    assert!(l.standable(cell(x, y)), "{facing} {variant} leaves ({x}, {y}) free");
                }
            }
            assert!(!piece_accepts(&pv("partition", 5, 4, facing, 2)), "no doorframe variant");
        }
        for facing in ["ne", "nw"] {
            assert!(!piece_accepts(&p("partition", 5, 4, facing)), "{facing} is not an axis");
        }
        assert!(parse(&base(vec![p("partition", 5, 4, "sw")])).seats().len() == 8, "not a seat");
    }

    // packages/shared/test/floor-sit-mood-contract.test.ts (OME-1499)
    // packages/shared/test/pair-contract.test.ts (OME-1671)
    #[test]
    fn pairs_is_an_optional_flag_kept_as_sent() {
        assert!(!parse(&base(vec![])).to_json().contains("pairs"), "absent stays absent");
        for flag in [true, false] {
            let mut v = base(vec![]);
            v["pairs"] = json!(flag);
            assert!(RoomLayout::parse_input(v.to_string().as_bytes()).is_ok());
            assert!(parse(&v).to_json().ends_with(&format!(r#","pairs":{flag}}}"#)));
        }
        for bad in [json!("true"), json!(1), json!(null)] {
            let mut v = base(vec![]);
            v["pairs"] = bad;
            assert!(RoomLayout::parse(v.to_string().as_bytes()).is_err());
            assert!(RoomLayout::parse_input(v.to_string().as_bytes()).is_err());
        }
    }

    #[test]
    fn mood_is_optional_and_a_layout_without_one_loads_as_none() {
        let old = parse(&base(vec![]));
        assert_eq!(old.mood(), Mood::None);
        assert!(!old.to_json().contains("mood"), "absent stays absent");
        for (text, mood) in [
            ("none", Mood::None),
            ("warm", Mood::Warm),
            ("cool", Mood::Cool),
            ("night", Mood::Night),
        ] {
            let mut v = base(vec![]);
            v["mood"] = json!(text);
            assert_eq!(parse(&v).mood(), mood);
            assert!(RoomLayout::parse_input(v.to_string().as_bytes()).is_ok());
            assert!(parse(&v).to_json().ends_with(&format!(r#","mood":"{text}"}}"#)));
        }
        for bad in [json!("dark"), json!("Warm"), json!(null), json!(0)] {
            let mut v = base(vec![]);
            v["mood"] = bad;
            assert!(RoomLayout::parse(v.to_string().as_bytes()).is_err());
            assert!(RoomLayout::parse_input(v.to_string().as_bytes()).is_err());
        }
    }

    // packages/shared/test/layout-contract.test.ts:67
    #[test]
    fn the_floor_is_10_and_a_layout_holds_32_pieces() {
        assert_eq!(FLOOR_CELLS, 10);
        assert_eq!(MAX_FURNITURE, 32);
        // The literals in the wire attributes.
        assert!(piece_accepts(&p("plant", 9, 9, "se")));
        assert!(!piece_accepts(&p("plant", 10, 9, "se")));
    }

    // packages/shared/test/layout-contract.test.ts:74
    #[test]
    fn default_layout_parses_and_is_todays_room() {
        let d = default_layout();
        assert!(accepts(&serde_json::to_value(&d).unwrap()));
        assert_eq!(RoomLayout::parse(d.to_json().as_bytes()), Ok(d.clone()));
        // :78 seats are today's SEAT_CELLS in order, facing the TV
        let seats = seats_of(&d);
        let cells: Vec<[u32; 2]> = seats.iter().map(|s| [s.0, s.1]).collect();
        assert_eq!(cells, TODAY.iter().map(|[c, r]| [u32::from(*c), u32::from(*r)]).collect::<Vec<_>>());
        let facings: Vec<Facing> = seats.iter().map(|s| s.2).collect();
        use Facing::{Ne, Nw};
        assert_eq!(facings, [Ne, Ne, Nw, Nw, Ne, Ne, Nw, Nw]);
        // :83 corner TV, 7x7 rug, lamp, plant
        let others: Vec<(Kind, u8, u8)> = d
            .furniture()
            .iter()
            .filter(|f| f.kind != Kind::Armchair)
            .map(|f| (f.kind, f.col, f.row))
            .collect();
        assert_eq!(
            others,
            [(Kind::Tv, 0, 0), (Kind::Rug, 1, 1), (Kind::Lamp, 9, 0), (Kind::Plant, 0, 9)]
        );
    }

    #[test]
    fn canonical_json_has_the_ts_key_order_and_omits_an_absent_variant() {
        let l = parse(&layout(vec![
            tv(),
            pv("sofa", 1, 5, "ne", 1),
            p("sofa", 4, 5, "ne"),
            p("couch", 6, 1, "nw"),
            p("wingback", 8, 8, "sw"),
            pv("beanbag", 7, 7, "se", 1),
        ]));
        assert_eq!(
            l.to_json(),
            r#"{"furniture":[{"kind":"tv","col":0,"row":0,"facing":"se"},{"kind":"sofa","col":1,"row":5,"facing":"ne","variant":1},{"kind":"sofa","col":4,"row":5,"facing":"ne"},{"kind":"couch","col":6,"row":1,"facing":"nw"},{"kind":"wingback","col":8,"row":8,"facing":"sw"},{"kind":"beanbag","col":7,"row":7,"facing":"se","variant":1}]}"#
        );
    }

    #[test]
    fn a_variant_written_as_zero_is_kept_and_two_layouts_compare_by_value() {
        let a = parse(&base(vec![]));
        let reordered = canon_base().replace(
            r#""kind":"tv","col":0,"row":0,"facing":"se""#,
            r#""facing":"se","kind":"tv","row":0,"col":0"#,
        );
        assert_eq!(RoomLayout::parse(reordered.as_bytes()), Ok(a.clone()));
        let with_zero = parse(&layout(std::iter::once(pv("tv", 0, 0, "se", 0)).chain(chairs()).collect()));
        assert_ne!(with_zero, a);
    }

    // packages/shared/test/layout-contract.test.ts:99
    #[test]
    fn a_snapshot_layout_that_is_null_is_refused() {
        assert!(RoomLayout::parse(b"null").is_err());
    }

    // packages/shared/test/layout-contract.test.ts:113
    #[test]
    fn every_set_g_piece_with_multi_seat_sofas() {
        assert!(accepts(&catalogue_room()));
        // :117 seat i is the i-th seat cell across seat pieces, in furniture order
        use Facing::{Ne, Nw, Se, Sw};
        assert_eq!(
            seats_of(&parse(&catalogue_room())),
            [
                (1, 5, Ne),
                (2, 5, Ne),
                (4, 5, Ne),
                (5, 5, Ne),
                (6, 1, Nw),
                (6, 2, Nw),
                (8, 8, Sw),
                (7, 7, Se)
            ]
        );
    }

    // packages/shared/test/layout-contract.test.ts:130
    #[test]
    fn a_runner_may_sit_under_seats() {
        assert!(accepts(&base(vec![p("runner", 3, 5, "nw")])));
    }

    fn free_cells() -> Vec<(u8, u8)> {
        let used: HashSet<(u8, u8)> = std::iter::once((0, 0)).chain(TODAY.iter().map(|[c, r]| (*c, *r))).collect();
        (0..10)
            .flat_map(|c| (0..10).map(move |r| (c, r)))
            .filter(|k| !used.contains(k))
            .collect()
    }

    // packages/shared/test/layout-contract.test.ts:134
    #[test]
    fn exactly_max_furniture_pieces_and_one_more_is_refused() {
        let fill = |n: usize| -> Vec<Value> { free_cells().into_iter().take(n).map(|(c, r)| p("sidetable", c, r, "sw")).collect() };
        let full = base(fill(MAX_FURNITURE - 9));
        assert_eq!(full["furniture"].as_array().unwrap().len(), MAX_FURNITURE);
        assert!(accepts(&full));
        assert!(accepts_input(&full));
        // :199 over MAX_FURNITURE even when every other rule holds
        let over = base(fill(MAX_FURNITURE - 8));
        assert_eq!(over["furniture"].as_array().unwrap().len(), MAX_FURNITURE + 1);
        assert!(!accepts(&over));
        assert!(!accepts_input(&over));
    }

    // packages/shared/test/layout-contract.test.ts:177
    #[test]
    fn rejected_layouts() {
        let no_tv = layout(chairs());
        let tv2 = base(vec![p("tv", 9, 9, "se")]);
        let seven = layout(std::iter::once(tv()).chain(chairs().into_iter().skip(1)).collect());
        let nine = base(vec![chair(9, 9)]);
        let nine_sofa = layout(
            std::iter::once(tv())
                .chain(chairs().into_iter().skip(1))
                .chain([p("sofa", 8, 8, "ne")])
                .collect(),
        );
        let dup_chair = layout(
            std::iter::once(tv())
                .chain(chairs().into_iter().skip(1))
                .chain([chair(2, 4)])
                .collect(),
        );
        let cases = [
            ("no tv", no_tv),
            ("two tvs", tv2),
            ("seven seats", seven),
            ("nine seats", nine),
            ("nine seats via a sofa", nine_sofa),
            ("two chairs on one cell", dup_chair),
            ("a solid piece on the tv", base(vec![p("plant", 0, 0, "se")])),
            ("a sofa's second cell on a chair", base(vec![p("sofa", 0, 5, "ne")])),
            ("two rugs overlapping", base(vec![p("rug", 1, 1, "se"), p("runner", 2, 2, "ne")])),
            (
                "two frames on one wall segment",
                base(vec![p("frame", 2, 0, "sw"), pv("frame", 2, 0, "sw", 1)]),
            ),
            ("furniture not an array", json!({"furniture":{}})),
            ("missing furniture", json!({})),
        ];
        for (name, input) in cases {
            assert!(!accepts(&input), "{name}");
            assert!(!accepts_input(&input), "{name}");
        }
    }

    // packages/shared/test/layout-contract.test.ts:201
    #[test]
    fn accepted_pieces() {
        let cases = [
            p("armchair", 0, 0, "sw"),
            pv("sofa", 0, 0, "ne", 1),
            p("rug", 3, 3, "se"),
            p("runner", 7, 8, "ne"),
            p("frame", 0, 9, "se"),
            pv("floorcushion", 4, 4, "nw", 1),
            pv("bench", 8, 9, "ne", 1),
            p("turntable", 7, 0, "sw"),
            pv("speaker", 0, 6, "se", 1),
            pv("cat", 9, 5, "sw", 1),
            p("wallshelf", 7, 0, "sw"),
            pv("garland", 0, 2, "se", 1),
            p("coffeetable", 4, 4, "se"),
            pv("pouf", 5, 5, "nw", 1),
            pv("neonsign", 3, 0, "sw", 1),
            p("aquarium", 6, 6, "sw"),
            p("arcade", 2, 7, "se"),
            p("wallclock", 0, 3, "se"),
            p("hammock", 4, 4, "nw"),
            pv("stool", 3, 3, "ne", 1),
            p("barcounter", 4, 4, "sw"),
            pv("piano", 0, 2, "se", 1),
            p("fireplace", 7, 0, "sw"),
        ];
        for c in cases {
            assert!(piece_accepts(&c), "{c}");
        }
        // :215 an unknown extra key (server objects are non-strict)
        let extra = json!({"kind":"tv","col":0,"row":0,"facing":"se","glow":true});
        assert!(piece_accepts(&extra));
        let with_extra = canon_base().replace(
            r#""kind":"tv","col":0,"row":0,"facing":"se""#,
            r#""kind":"tv","col":0,"row":0,"facing":"se","glow":true"#,
        );
        assert!(with_extra.contains("glow"));
        assert_eq!(RoomLayout::parse(with_extra.as_bytes()), Ok(parse(&base(vec![]))));
    }

    // packages/shared/test/layout-contract.test.ts:219
    #[test]
    fn rejected_pieces() {
        let cases = [
            ("an unknown kind", p("throne", 0, 0, "se")),
            ("a kind that only exists as an atlas id", p("kilim", 0, 0, "ne")),
            ("a non-integer col", json!({"kind":"tv","col":1.5,"row":0,"facing":"se"})),
            ("a non-integer row", json!({"kind":"tv","col":0,"row":0.25,"facing":"se"})),
            ("a string cell", json!({"kind":"tv","col":"0","row":0,"facing":"se"})),
            ("a negative cell", json!({"kind":"tv","col":-1,"row":0,"facing":"se"})),
            ("a cell past the floor", p("tv", 0, 10, "se")),
            ("an unknown facing", p("armchair", 0, 0, "n")),
            ("a facing the piece does not have", p("sidetable", 0, 0, "ne")),
            ("a facing a one-sprite piece does not have", p("lamp", 0, 0, "sw")),
            ("a variant the piece does not have", pv("wingback", 0, 0, "ne", 1)),
            (
                "a negative variant",
                json!({"kind":"sofa","col":0,"row":0,"facing":"ne","variant":-1}),
            ),
            (
                "a non-integer variant",
                json!({"kind":"sofa","col":0,"row":0,"facing":"ne","variant":0.5}),
            ),
            (
                "a null variant",
                json!({"kind":"sofa","col":0,"row":0,"facing":"ne","variant":null}),
            ),
            ("a rug hanging off the floor", p("rug", 4, 3, "se")),
            ("a runner hanging off the floor", p("runner", 8, 0, "ne")),
            ("a turned runner hanging off the floor", p("runner", 0, 8, "nw")),
            ("a sofa hanging off the floor", p("sofa", 9, 0, "ne")),
            ("a turned sofa hanging off the floor", p("sofa", 0, 9, "se")),
            ("a bookcase away from its wall", p("bookshelf", 3, 1, "sw")),
            ("a left-wall bookcase away from its wall", p("bookshelf", 1, 3, "se")),
            ("a frame off the wall", p("frame", 2, 1, "sw")),
            ("a frame on a window segment", p("frame", 0, 5, "se")),
            ("a frame on a sconce segment", p("frame", 8, 0, "sw")),
            ("a missing facing", json!({"kind":"tv","col":0,"row":0})),
            ("a third floor cushion colour", pv("floorcushion", 0, 0, "ne", 2)),
            ("a bench hanging off the floor", p("bench", 9, 0, "ne")),
            ("a turned bench hanging off the floor", p("bench", 0, 9, "se")),
            ("a turntable facing the TV", p("turntable", 0, 0, "ne")),
            ("a second turntable colour", pv("turntable", 0, 0, "se", 1)),
            ("a speaker facing the TV", p("speaker", 0, 0, "nw")),
            ("a cat facing the TV", p("cat", 0, 0, "ne")),
            ("a wall shelf off the wall", p("wallshelf", 3, 2, "sw")),
            ("a wall shelf on a window segment", p("wallshelf", 0, 6, "se")),
            ("a fourth wall shelf colour", pv("wallshelf", 2, 0, "sw", 3)),
            ("a garland off the wall", p("garland", 1, 3, "se")),
            ("a garland on a sconce segment", p("garland", 8, 0, "sw")),
            ("a garland facing the TV", p("garland", 2, 0, "ne")),
            ("a coffee table facing the TV", p("coffeetable", 4, 4, "ne")),
            ("a fifth pouf colour", pv("pouf", 5, 5, "se", 4)),
            ("a neon sign off the wall", p("neonsign", 1, 3, "se")),
            ("a neon sign on a sconce segment", p("neonsign", 8, 0, "sw")),
            ("a second aquarium colour", pv("aquarium", 6, 6, "sw", 1)),
            ("an arcade cabinet facing the TV", p("arcade", 2, 7, "nw")),
            ("a wall clock on a window segment", p("wallclock", 0, 6, "se")),
            ("a hammock hanging off the floor", p("hammock", 9, 0, "ne")),
            ("a second hammock colour", pv("hammock", 4, 4, "ne", 1)),
            ("a fifth stool colour", pv("stool", 3, 3, "ne", 4)),
            ("a bar counter facing the TV", p("barcounter", 4, 4, "ne")),
            ("a piano facing the TV", p("piano", 4, 4, "nw")),
            ("a fireplace away from its wall", p("fireplace", 3, 1, "sw")),
        ];
        for (name, input) in cases {
            assert!(!piece_accepts(&input), "{name}");
        }
    }

    #[test]
    fn the_strict_parser_refuses_unknown_keys_at_both_levels_the_loose_one_strips_them() {
        let piece_extra = canon_base().replace(
            r#""kind":"tv","col":0,"row":0,"facing":"se""#,
            r#""kind":"tv","col":0,"row":0,"facing":"se","glow":true"#,
        );
        let layout_extra = canon_base().replace(r#"{"furniture""#, r#"{"extra":1,"furniture""#);
        for raw in [piece_extra, layout_extra] {
            assert!(RoomLayout::parse_input(raw.as_bytes()).is_err(), "{raw}");
            assert_eq!(RoomLayout::parse(raw.as_bytes()), Ok(parse(&base(vec![]))), "{raw}");
        }
    }

    // packages/shared/test/layout-contract.test.ts:260
    #[test]
    fn footprints_turn_with_the_facing() {
        let at = |kind, facing| footprint_cells(&Furniture::new(kind, 2, 3, facing));
        assert_eq!(at(Kind::Sofa, Facing::Ne), [(2, 3), (3, 3)]);
        assert_eq!(at(Kind::Sofa, Facing::Se), [(2, 3), (2, 4)]);
        assert!(footprint_cells(&Furniture::new(Kind::Frame, 2, 0, Facing::Sw)).is_empty());
        assert_eq!(footprint_cells(&Furniture::new(Kind::Rug, 1, 1, Facing::Se)).len(), 49);
    }

    // packages/shared/test/dank-dungeon-contract.test.ts (OME-1982): a queen bed, two sleepers side by side.
    #[test]
    fn a_bed_covers_2x2_and_seats_two_side_by_side_in_every_facing() {
        for facing in FACINGS {
            let bed = Furniture::new(Kind::Bed, 4, 0, facing);
            assert_eq!(footprint_cells(&bed), [(4, 0), (4, 1), (5, 0), (5, 1)], "{facing:?}");
            let next = if matches!(facing, Facing::Ne | Facing::Sw) {
                (5, 0)
            } else {
                (4, 1)
            };
            let seats: Vec<_> = layout_seats(&[bed]).iter().map(|s| (s.col, s.row, s.facing)).collect();
            assert_eq!(seats, [(4, 0, facing), (next.0, next.1, facing)], "{facing:?}");
        }
    }

    // packages/shared/test/layout-contract.test.ts:291
    #[test]
    fn the_armchair_faces_every_way_and_seats_one() {
        assert_eq!(spec(Kind::Armchair).facings, FACINGS);
        assert_eq!(footprint_cells(&Furniture::new(Kind::Armchair, 0, 0, Facing::Ne)), [(0, 0)]);
        assert!(spec(Kind::Armchair).seats);
    }

    // packages/shared/test/layout-contract.test.ts:297 (the walls of assets/room/room.json have fixtures at 5, 6, 8)
    #[test]
    fn wall_fixture_segments() {
        assert_eq!(WALL_FIXTURE_SEGMENTS, [5, 6, 8]);
    }

    // packages/shared/test/layout-contract.test.ts (OME-1463): the recolours (OME-1462) raise six kinds' variants.
    #[test]
    fn the_recoloured_kinds_take_their_extra_colours_and_no_more() {
        for (kind, n) in [
            ("sofa", 4),
            ("beanbag", 4),
            ("pouf", 4),
            ("stool", 4),
            ("runner", 4),
            ("rug", 3),
            ("couch", 2),
            ("floorcushion", 2),
        ] {
            let (facing, col, row) = if kind == "runner" { ("ne", 4, 4) } else { ("se", 3, 3) };
            assert!(piece_accepts(&pv(kind, col, row, facing, n - 1)), "{kind} {}", n - 1);
            assert!(!piece_accepts(&pv(kind, col, row, facing, n)), "{kind} {n}");
        }
        // OME-1507 (art OME-1500): the two wall pieces take two recolours each.
        for (kind, col, row, facing) in [("frame", 2, 0, "sw"), ("garland", 0, 2, "se")] {
            assert!(piece_accepts(&pv(kind, col, row, facing, 3)), "{kind} 3");
            assert!(!piece_accepts(&pv(kind, col, row, facing, 4)), "{kind} 4");
        }
    }

    // packages/shared/test/dank-dungeon-contract.test.ts
    #[test]
    fn the_six_dank_dungeon_kinds_follow_the_readme_table() {
        for (kind, facing) in [
            ("bed", "nw"),
            ("whirlpool", "ne"),
            ("bed", "se"),
            ("whirlpool", "sw"),
            ("mirror", "se"),
            ("minibar", "sw"),
            ("desk", "se"),
        ] {
            let (col, row) = if kind == "mirror" { (0, 2) } else { (3, 3) };
            assert!(piece_accepts(&p(kind, col, row, facing)), "{kind} {facing}");
        }
        for (kind, facing) in [("mirror", "ne"), ("minibar", "nw"), ("desk", "ne"), ("washbasin", "nw")] {
            assert!(!piece_accepts(&p(kind, 0, 2, facing)), "{kind} {facing}");
        }
        assert!(piece_accepts(&p("washbasin", 0, 7, "se")));
        assert!(!piece_accepts(&pv("bed", 3, 3, "nw", 1)));
    }

    #[test]
    fn every_kind_has_a_spec_and_a_distinct_serialised_name() {
        let names: HashSet<String> = KINDS.iter().map(|k| serde_json::to_string(k).unwrap()).collect();
        assert_eq!(names.len(), KINDS.len());
        for k in KINDS {
            assert!(!spec(k).facings.is_empty());
        }
    }

    fn door(col: u8, row: u8, target: Value) -> Value {
        json!({"kind":"door","col":col,"row":row,"facing": if row == 0 {"sw"} else {"se"},"target":target})
    }

    // packages/shared/test/teleport-contract.test.ts (OME-1545)
    #[test]
    fn a_pad_is_a_fixed_floor_piece_with_2_variants_and_a_layout_holds_0_or_2() {
        let s = spec(Kind::Pad);
        assert_eq!(
            (s.layer, s.facings, s.cols, s.rows, s.seats, s.variants, s.wall_backed),
            (Layer::Floor, FIXED, 1, 1, false, 2, false)
        );
        let pad = |col: u8, row: u8| p("pad", col, row, "se");
        assert!(RoomLayout::parse(base(vec![pad(9, 1), pad(1, 9)]).to_string().as_bytes()).is_ok());
        assert!(RoomLayout::parse_input(base(vec![pad(9, 1), pad(1, 9)]).to_string().as_bytes()).is_ok());
        for bad in [vec![pad(9, 1)], vec![pad(9, 1), pad(1, 9), pad(8, 9)], vec![pad(9, 1), pad(9, 1)]] {
            assert!(RoomLayout::parse(base(bad.clone()).to_string().as_bytes()).is_err());
            assert!(RoomLayout::parse_input(base(bad).to_string().as_bytes()).is_err());
        }
    }

    // packages/shared/test/teleport-contract.test.ts (OME-1545)
    #[test]
    fn teleport_goes_from_one_pad_to_the_other_and_nowhere_else() {
        let c = |x: u64, y: u64| FloorCell::new(x, y).unwrap();
        let l = parse(&base(vec![p("pad", 9, 1, "se"), p("pad", 1, 9, "se")]));
        assert!(l.can_teleport(Some(c(9, 1)), c(1, 9)));
        assert!(l.can_teleport(Some(c(1, 9)), c(9, 1)));
        assert!(!l.can_teleport(Some(c(9, 1)), c(9, 1)));
        assert!(!l.can_teleport(Some(c(8, 1)), c(1, 9)));
        assert!(!l.can_teleport(Some(c(9, 1)), c(2, 9)));
        assert!(!l.can_teleport(None, c(1, 9)));
        assert!(!parse(&base(vec![])).can_teleport(Some(c(9, 1)), c(1, 9)));
        // the plant stands on (0, 9): a covered pad is no way out
        let covered = parse(&base(vec![p("plant", 0, 9, "se"), p("pad", 9, 1, "se"), p("pad", 0, 9, "se")]));
        assert!(!covered.can_teleport(Some(c(9, 1)), c(0, 9)));
    }

    // packages/shared/test/door-roll-contract.test.ts (OME-1423)
    #[test]
    fn a_door_is_a_wall_backed_camera_object_with_a_room_id_target() {
        let s = spec(Kind::Door);
        assert_eq!(
            (s.layer, s.facings, s.cols, s.rows, s.seats, s.variants, s.wall_backed),
            (Layer::Object, CAMERA, 1, 1, false, 2, true)
        );
        let l = parse(&base(vec![
            json!({"kind":"door","col":3,"row":0,"facing":"sw","target":"film-club","variant":1}),
        ]));
        assert!(
            l.to_json()
                .ends_with(r#"{"kind":"door","col":3,"row":0,"facing":"sw","variant":1,"target":"film-club"}]}"#)
        );
        for bad in [
            json!(null),
            json!(""),
            json!("Lobby"),
            json!("https://evil.example/"),
            json!("a".repeat(33)),
            json!(7),
        ] {
            assert!(!accepts(&base(vec![door(3, 0, bad.clone())])), "{bad}");
        }
        assert!(!accepts(&base(vec![p("door", 3, 0, "sw")])));
        assert!(!piece_accepts(
            &json!({"kind":"plant","col":9,"row":9,"facing":"se","target":"lobby"})
        ));
        assert!(!accepts(&base(vec![door(3, 1, json!("lobby"))])));
    }

    #[test]
    fn a_layout_holds_at_most_two_doors() {
        assert_eq!(MAX_DOORS, 2);
        let two = base(vec![door(3, 0, json!("a")), door(0, 3, json!("b"))]);
        assert!(accepts(&two) && accepts_input(&two));
        let three = base(vec![door(3, 0, json!("a")), door(4, 0, json!("b")), door(0, 3, json!("c"))]);
        assert!(!accepts(&three) && !accepts_input(&three));
    }

    #[test]
    fn has_door_to_names_any_door_target() {
        let l = parse(&base(vec![door(3, 0, json!("film-club")), door(0, 3, json!("lobby"))]));
        let id = |s: &str| crate::contract::ids::RoomId::parse(s).unwrap();
        assert!(l.has_door_to(&id("lobby")) && l.has_door_to(&id("film-club")));
        assert!(!l.has_door_to(&id("film")));
        assert!(!default_layout().has_door_to(&id("lobby")));
    }

    #[test]
    fn piece_seats_are_the_seat_indices_a_piece_gives() {
        let f = |kind, col, row, facing| Furniture::new(kind, col, row, facing);
        let furniture = [
            f(Kind::Tv, 0, 0, Facing::Se),
            f(Kind::Sofa, 1, 5, Facing::Ne),
            f(Kind::Armchair, 2, 2, Facing::Ne),
            f(Kind::Sofa, 4, 5, Facing::Ne),
        ];
        assert_eq!(piece_seats(&furniture, 0), Some(0..0));
        assert_eq!(piece_seats(&furniture, 1), Some(0..2));
        assert_eq!(piece_seats(&furniture, 2), Some(2..3));
        assert_eq!(piece_seats(&furniture, 3), Some(3..5));
        assert_eq!(piece_seats(&furniture, 4), None);
    }

    // packages/shared/test/preset-contract.test.ts:5
    #[test]
    fn preset_ids() {
        let ids: Vec<&str> = ROOM_PRESET_IDS.iter().map(|i| i.as_str()).collect();
        assert_eq!(
            ids,
            ["classic", "cinema", "living", "lounge", "cafe", "bar", "empty", "dank-dungeon"]
        );
        assert_eq!(DEFAULT_ROOM_PRESET.as_str(), "classic");
        for id in ROOM_PRESET_IDS {
            assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{}\"", id.as_str()));
            assert_eq!(parse_json_preset(id.as_str()), Some(id));
        }
        for bad in ["unknown", "Classic", "", "../classic", "null", "{}", "0"] {
            assert_eq!(parse_json_preset(bad), None, "{bad}");
        }
        assert!(serde_json::from_str::<RoomPresetId>("null").is_err());
        assert!(serde_json::from_str::<RoomPresetId>("{}").is_err());
        assert!(serde_json::from_str::<RoomPresetId>("0").is_err());
    }

    fn parse_json_preset(s: &str) -> Option<RoomPresetId> {
        serde_json::from_value(Value::String(s.to_owned())).ok()
    }
}
