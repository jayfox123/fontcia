export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const NO_OP_DRAG_THRESHOLD_PX = 4;

export function normalizeDragRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function isNoOpDrag(rect: Rect): boolean {
  return Math.hypot(rect.width, rect.height) < NO_OP_DRAG_THRESHOLD_PX;
}
