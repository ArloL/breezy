import type { Grid } from "./grid.ts";
import type { Area } from "./view.ts";
import type { Cam, Rect } from "./types.ts";

/** Where the camera shows on screen: the view keeps the board's model and leaves the showing to this. */
export interface Surface {
  /** Shows the camera. */
  apply(cam: Cam): void;
  /** The board's area on screen. */
  stage(): Area;
  /** Draws the grid for `cam`, with `board` in world coordinates. */
  drawGrid(cam: Cam, board: Rect): void;
  /** The board has taken in what shows. */
  rested(): void;
  dispose(): void;
  /** The camera as drawn, which a native pinch's transform moves ahead of `cam`. */
  shownCam(cam: Cam): Cam;
  /** Whether the board paints over the top bar. */
  coverTop(): boolean;
  /** How far the dot grid as drawn falls short of the view, in CSS px. */
  gridShort(): number;
}

/** The camera moves the world layer by a transform. */
export class CameraSurface implements Surface {
  world: HTMLElement;
  grid: Grid;

  constructor(world: HTMLElement, grid: Grid) {
    this.world = world;
    this.grid = grid;
  }

  apply({ x, y, zoom }: Cam) {
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  }

  stage(): Area {
    return { top: 0, left: 0, right: this.grid.width, bottom: this.grid.height };
  }

  drawGrid({ x, y, zoom }: Cam, b: Rect) {
    this.grid.draw({ x, y, zoom }, { x: b.x * zoom + x, y: b.y * zoom + y, w: b.w * zoom, h: b.h * zoom });
  }

  rested() {}

  shownCam(cam: Cam): Cam {
    return cam;
  }

  coverTop() {
    return false;
  }

  gridShort() {
    return this.grid.short();
  }

  dispose() {}
}
