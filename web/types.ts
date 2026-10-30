/** The board as stored and synced; BreezyKit's `Board` has the same shape. */
export interface Board {
  cards: Card[];
  lanes: Lane[];
}

export interface Card {
  id: string;
  x: number;
  y: number;
  w: number;
  text: string;
  /** 1–5 */
  color: number;
  notes?: string;
}

export interface Lane {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

/** A card's height on screen, which only the view can measure. */
export type HeightOf = (id: string) => number;

/** Where the view looks: the screen position of the world origin, and the zoom. */
export interface Cam extends Point {
  zoom: number;
}

/** A card as the clipboard carries it: where and how tall it stood, for placing its copy. */
export interface ClipCard {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** 1–5 */
  color: number;
  notes?: string;
}

/** Cards copied from `board`, in reading order. */
export interface Clip {
  v: 1;
  board: string;
  cards: ClipCard[];
}
