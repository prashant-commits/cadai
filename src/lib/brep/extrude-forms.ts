/**
 * The two algebra-mode ways to extrude a profile, worded once. The brep-build prompt, the
 * builder-mode rejection reason and the repair hint all use this constant, so the three texts
 * cannot drift apart (the two forms are not interchangeable: they point different ways).
 *
 * Verified on build123d 0.13: Plane.XY extrudes +Z, Plane.YZ extrudes +X (x starts at 0),
 * Plane.XZ extrudes -Y; a bare make_face(Polyline(...)) lies in XY and extrudes +Z.
 */
export const EXTRUDE_FORMS =
  'extrude(Plane.YZ * Polygon(*pts, align=None), amount=w) (Plane.XY, Plane.YZ or Plane.XZ * Polygon(...) chooses the sketch plane and the extrusion direction: +Z, +X or -Y) ' +
  'or extrude(make_face(Polyline(*pts, close=True)), amount=w) (that face lies in XY and extrudes along +Z; for any other direction write Plane.YZ * make_face(Polyline(*pts, close=True)))';
