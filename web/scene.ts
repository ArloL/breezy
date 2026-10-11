import type { Board, Cam, Card, Rect } from "./types.ts";

/** An item as a device draws it, in world points. */
export interface SceneItem extends Rect {
  id: string;
  selected: boolean;
  held: boolean;
  /** Cards only: lifted by a drag. */
  raised?: boolean;
  color?: number;
  text?: string;
  title?: string;
}

/** What a device shows of its open board; BreezyKit's `Scene` has the same shape. */
export interface Scene {
  cards: SceneItem[];
  lanes: SceneItem[];
  turned: string | null;
  marquee: Rect | null;
  /** Where the view looks: the screen point of the world's origin, and the zoom. */
  camera: Cam;
}

/** What `sceneOf` needs of the app's state. */
export interface SceneState {
  selection: Set<string>;
  held: Set<string>;
  lifted: Set<string>;
  turned: string | null;
  marquee: Rect | null;
  float: { x?: number; y?: number; w?: number; h?: number } | null;
}

/** Where `View` draws each item: what a finger or the pointer holds floats off the grid. */
export function sceneOf(b: Board, s: SceneState, rectOf: (c: Card) => Rect, camera: Cam): Scene {
  const f = (id: string) => ({ x: 0, y: 0, w: 0, h: 0, ...(s.held.has(id) && s.float) });
  return {
    cards: b.cards.map((c) => {
      const r = rectOf(c);
      const o = s.float?.x !== undefined ? f(c.id) : { x: 0, y: 0 };
      return { id: c.id, x: c.x + o.x, y: c.y + o.y, w: r.w, h: r.h, selected: s.selection.has(c.id), held: s.held.has(c.id),
        raised: s.lifted.has(c.id), color: c.color, text: c.text };
    }),
    lanes: b.lanes.map((l) => {
      const o = f(l.id);
      return { id: l.id, x: l.x + o.x, y: l.y + o.y, w: l.w + o.w, h: l.h + o.h, selected: s.selection.has(l.id), held: s.held.has(l.id),
        title: l.title };
    }),
    turned: s.turned,
    marquee: s.marquee,
    camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
  };
}
