export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function visibleBounds(
  bounds: WindowBounds,
  workAreas: readonly WindowBounds[],
): WindowBounds {
  if (workAreas.length === 0) return bounds;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  let nearest = workAreas[0]!;
  let distance = Infinity;
  for (const area of workAreas) {
    const dx = Math.max(area.x - centerX, 0, centerX - area.x - area.width);
    const dy = Math.max(area.y - centerY, 0, centerY - area.y - area.height);
    const next = dx * dx + dy * dy;
    if (next < distance) {
      nearest = area;
      distance = next;
    }
  }
  const width = Math.min(bounds.width, nearest.width);
  const height = Math.min(bounds.height, nearest.height);
  return {
    width,
    height,
    x: Math.max(
      nearest.x,
      Math.min(bounds.x, nearest.x + nearest.width - width),
    ),
    y: Math.max(
      nearest.y,
      Math.min(bounds.y, nearest.y + nearest.height - height),
    ),
  };
}
