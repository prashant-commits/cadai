# build123d 0.13 cheat sheet

Every fenced example below is executed in CI against build123d 0.13.0. Units are mm. z = 0 is the floor. `align=(Align.MIN, Align.MIN, Align.MIN)` puts a primitive's min corner at its location. The default align is CENTER.

Your code runs inside a script that already has these in scope, so never write an import line: everything from build123d, plus `sin`, `cos`, `tan`, `radians`, `sqrt` and `pi` from `math`. These take radians, as in Python: write `sin(radians(30))` for 30 degrees.

**Bodies use algebra mode only.** Every shape is a value: build it, combine it with `+`, `-`, `&`, place it with `Pos(...) * shape` or `Rot(...) * shape`, and `return` it. Never write `with BuildPart`, `with BuildSketch` or `with BuildLine`: a body with one is rejected and the part is drawn as a plain block. `extrude` and `revolve` outside a builder take the profile as their first argument; without one they fail with `A face or sketch must be provided`.

## Primitives

No other keywords exist. Box sizes are x, y, z. Cylinder runs along +Z. There is no `axis=` and no `diameter=`. Cone takes bottom radius, top radius, height. Sphere takes a radius. Cut a hole by subtracting a `Cylinder` that overshoots both faces.

Point a cylinder along X with `rotation=(0, 90, 0)`, and along Y with `rotation=(-90, 0, 0)`.

```python
Box(10, 10, 10, rotation=(0, 0, 0), align=(Align.MIN, Align.MIN, Align.MIN), mode=Mode.ADD)
Cylinder(3, 10, arc_size=360, rotation=(0, 90, 0), align=(Align.MIN, Align.MIN, Align.MIN))
Cone(5, 2, 8, rotation=(0, 0, 0), align=(Align.MIN, Align.MIN, Align.MIN))
Sphere(4)
```

## Profiles: extrude or revolve a face

A profile is a 2D shape (`Polygon`, `Rectangle`, `Circle`, `RegularPolygon`) or a face made from a closed line (`make_face(Polyline(...))`). Place it on a plane with `Plane.XY * profile`, then `extrude(profile, amount=...)` or `revolve(profile, axis, revolution_arc)`. `Polygon(..., align=None)` keeps the coordinates you wrote. Planes: `Plane.XY` (normal +Z), `Plane.XZ` (normal -Y; local x = X, local y = Z), `Plane.YZ` (normal +X; local x = Y, local y = Z). A profile on `Plane.YZ` extrudes along +X from x = 0 (`Plane.YZ.offset(d)` starts at x = d).

`extrude` takes `amount`, never `height` or `distance`. A triangle in the Y-Z plane, 80 mm wide along X, is:

```python
pts = [(0, 0), (20, 0), (0, 20)]
wedge = extrude(Plane.YZ * Polygon(*pts, align=None), amount=80)
wedge_b = extrude(Plane.YZ * make_face(Polyline(*pts, close=True)), amount=80)
flat = extrude(make_face(Polyline(*pts, close=True)), amount=80)
disc = extrude(Plane.XY * Circle(3), amount=2)
assert abs(wedge.bounding_box().size.X - 80) < 1e-6 and abs(wedge_b.volume - wedge.volume) < 1e-6
assert abs(flat.bounding_box().size.Z - 80) < 1e-6  # no plane: the profile lies in XY and extrudes along Z
```

`revolve` spins a profile that lies on one side of the axis (a profile that straddles it fails). The axis is in the profile's plane: here the rectangle is in X-Z and spins about Z.

```python
spun = revolve(Plane.XZ * Rectangle(5, 20, align=(Align.MIN, Align.MIN)), axis=Axis.Z, revolution_arc=360)
assert abs(spun.bounding_box().size.X - 10) < 1e-6
```

## Algebra style (place and combine)

`+` unions, `-` subtracts, `&` intersects. A cutter overshoots the faces it must break through.

```python
plate = Pos(0, 0, 0) * Box(80, 40, 5, align=(Align.MIN, Align.MIN, Align.MIN))
post = Pos(10, 10, 5) * Cylinder(4, 30, align=(Align.MIN, Align.MIN, Align.MIN))
body = plate + post
tube = Cylinder(10, 50, align=(Align.MIN, Align.MIN, Align.MIN)) - Pos(0, 0, -1) * Cylinder(8, 52, align=(Align.MIN, Align.MIN, Align.MIN))
```

## Separate parts

A lid, a drawer, or a loose axle stays its own solid. Assign the final Part or Compound to `result`.

```python
result = Compound([body, Pos(0, 0, 60) * Box(80, 40, 3, align=(Align.MIN, Align.MIN, Align.MIN))])
```

## Selectors

`sort_by(Axis.Z)[-1]` is the top face and `[0]` is the bottom. `filter_by` keeps faces whose normal is that axis, or edges parallel to it. Read sizes back from the bounding box.

```python
part = Box(80, 40, 5, align=(Align.MIN, Align.MIN, Align.MIN)) + Pos(10, 10, 5) * Cylinder(4, 30, align=(Align.MIN, Align.MIN, Align.MIN))
top = part.faces().sort_by(Axis.Z)[-1]
bottom = part.faces().sort_by(Axis.Z)[0]
y_faces = part.faces().filter_by(Axis.Y)
x_edges = part.edges().filter_by(Axis.X)
bb = part.bounding_box()
_ = (bb.min.Z, bb.max.X, bb.size.Y, top, bottom, len(y_faces), len(x_edges))
x_cyl = Cylinder(3, 10, rotation=(0, 90, 0), align=(Align.MIN, Align.MIN, Align.MIN)).bounding_box()
y_cyl = Cylinder(3, 10, rotation=(-90, 0, 0), align=(Align.MIN, Align.MIN, Align.MIN)).bounding_box()
assert x_cyl.size.X > 9.9 and y_cyl.size.Y > 9.9
```

## Fillet and chamfer (edge treatments)

Fillet rounds edges; chamfer bevels them. Select edges with `.filter_by(Axis.Z)`, `.sort_by(Axis.Z)[-1].edges()`, or use the safe helpers `_round(shape, r, edges="outer"|"vertical"|"top"|"all")` and `_bevel(shape, d, edges=...)` which catch geometry failures and degrade gracefully without failing the build.

```python
block = Box(30, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))
vert_edges = block.edges().filter_by(Axis.Z)
rounded_cols = fillet(vert_edges, 2)
top_edges = rounded_cols.faces().sort_by(Axis.Z)[-1].edges()
soft_top = fillet(top_edges, 1)
safe_box = _round(block, 2, edges="outer")
beveled = _bevel(block, 1, edges="top")
assert safe_box.is_valid and beveled.is_valid
```

## Rounded rectangles, arcs and splines

`RectangleRounded(width, height, radius=...)` makes a profile with pre-filleted corners. Complex profiles can be assembled from `ThreePointArc`, `Spline`, and `Line` edges inside a `Wire`, then turned into a face with `make_face(wire)`.

```python
r_rect = RectangleRounded(40, 25, radius=3, align=(Align.MIN, Align.MIN))
r_body = extrude(Plane.XY * r_rect, amount=12)

arc_edge = ThreePointArc((0, 0), (10, 4), (20, 0))
line_edges = [Line((20, 0), (20, -10)), Line((20, -10), (0, -10)), Line((0, -10), (0, 0))]
arc_face = make_face(Wire([arc_edge] + line_edges))
arc_solid = extrude(arc_face, amount=15)

spline_edge = Spline((0, 0), (10, 6), (20, 0))
spline_face = make_face(Wire([spline_edge] + line_edges))
spline_solid = extrude(spline_face, amount=15)
assert r_body.is_valid and arc_solid.is_valid and spline_solid.is_valid
```

## Loft and sweep

`loft([section1, section2, ...])` creates a solid smoothly transitioning between profiles at different planes/heights. `sweep(sections=profile, path=curve)` drives a cross-section along a 3D path.

```python
sec1 = Plane.XY * Rectangle(30, 30)
sec2 = Plane.XY.offset(25) * Circle(8)
lofted = loft([sec1, sec2])

sweep_path = ThreePointArc((0, 0, 5), (15, 0, 20), (0, 0, 35))
sweep_profile = Plane(origin=sweep_path @ 0, z_dir=sweep_path % 0) * Circle(3)
swept = sweep(sections=sweep_profile, path=sweep_path)
assert lofted.is_valid and swept.is_valid and swept.volume > 0
```

## Uniform-wall shell and patterns

`offset(solid, amount=-thickness, openings=open_faces)` creates a hollow shell with uniform walls, open at the selected faces.
In algebra mode, `GridLocations` and `PolarLocations` are iterable location lists; generate repeated features with list comprehensions and combine them with `Compound(...)`.

```python
solid_box = Box(50, 40, 20, align=(Align.MIN, Align.MIN, Align.MIN))
open_top = solid_box.faces().sort_by(Axis.Z)[-1]
tray = offset(solid_box, amount=-2, openings=open_top)

grid_cutters = Compound([loc * Cylinder(2, 25) for loc in GridLocations(12, 10, 2, 2)])
tray_with_holes = tray - Pos(25, 20, 0) * grid_cutters

polar_ribs = Compound([loc * Box(2, 10, 8, align=(Align.CENTER, Align.MIN, Align.MIN)) for loc in PolarLocations(radius=12, count=6)])
assert tray.is_valid and len(tray.solids()) == 1 and polar_ribs.is_valid
```

## Rules

- Every dimension is a named top-level variable (`name = number`) and every size and position is an expression over those names.
- Assign the final Part or Compound to `result`.

## Placing a new feature on an existing part (edits)

- Reuse the existing variables. Place the new part from them, for example `Pos(0, 0, base_t)` for something sitting on a base of thickness `base_t`.
- Or select the face it sits on: the top is `part.faces().sort_by(Axis.Z)[-1]` and the front is `part.faces().sort_by(Axis.Y)[0]`. Read its height with `.center().Z` and place the feature there with `Pos`.
- Keep every existing part unchanged. Add the feature with `+`.

```python
base_t = 5
base = Box(80, 40, base_t, align=(Align.MIN, Align.MIN, Align.MIN))
edit_top = base.faces().sort_by(Axis.Z)[-1]
edit_front = base.faces().sort_by(Axis.Y)[0]
feature = Pos(0, 0, base_t) * Box(10, 10, 4, align=(Align.MIN, Align.MIN, Align.MIN))
edited = base + feature
boss = Pos(0, 0, edit_top.center().Z) * Cylinder(2, 6, align=(Align.MIN, Align.MIN, Align.MIN))
assert edit_front is not None and (edited + boss).volume > base.volume
```
