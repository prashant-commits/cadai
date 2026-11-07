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
