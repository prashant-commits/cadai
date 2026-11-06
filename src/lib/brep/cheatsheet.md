# build123d 0.13 cheat sheet

Every fenced example below is executed in CI against build123d 0.13.0. Units are mm. z = 0 is the floor. `align=(Align.MIN, Align.MIN, Align.MIN)` puts a primitive's min corner at its location. The default align is CENTER.

```python
from build123d import *
from math import sin, cos, tan, radians, sqrt
```

build123d does not export `sin`, `cos`, `tan`, `radians`, or `sqrt`. Import them from `math`.

## Primitives

No other keywords exist. Box sizes are x, y, z. Cylinder runs along +Z. There is no `axis=` and no `diameter=`. Cone takes bottom radius, top radius, height. Sphere takes a radius. `Hole(radius, depth=None)` drills along -Z of the current workplane; `depth=None` means through.

Point a cylinder along X with `rotation=(0, 90, 0)`, and along Y with `rotation=(-90, 0, 0)`.

```python
Box(10, 10, 10, rotation=(0, 0, 0), align=(Align.MIN, Align.MIN, Align.MIN), mode=Mode.ADD)
Cylinder(3, 10, arc_size=360, rotation=(0, 90, 0), align=(Align.MIN, Align.MIN, Align.MIN))
Cone(5, 2, 8, rotation=(0, 0, 0), align=(Align.MIN, Align.MIN, Align.MIN))
Sphere(4)
```

## Sketches, then extrude or revolve

`Polygon(..., align=None)` keeps the coordinates you wrote. Planes: `Plane.XY` (normal +Z), `Plane.XZ` (normal -Y; local x = X, local y = Z), `Plane.YZ` (normal +X; local x = Y, local y = Z).

`extrude` takes `amount`, never `height` or `distance`. `revolve(axis=Axis.Z, revolution_arc=360)`.

```python
with BuildSketch(Plane.XY):
    Rectangle(10, 5, align=(Align.MIN, Align.MIN))
    Circle(2)
    RegularPolygon(3, 6)
with BuildSketch(Plane.XZ):
    Rectangle(4, 6, align=(Align.MIN, Align.MIN))
with BuildSketch(Plane.YZ):
    Circle(3)
```

```python
with BuildPart() as spun:
    with BuildSketch(Plane.XZ):
        Rectangle(5, 20, align=(Align.MIN, Align.MIN))
    revolve(axis=Axis.Z, revolution_arc=360)
```

## Builder style (one part)

```python
with BuildPart() as p:
    Box(80, 40, 5, align=(Align.MIN, Align.MIN, Align.MIN))
    with Locations((10, 10, 5)):
        Cylinder(4, 30, align=(Align.MIN, Align.MIN, Align.MIN))
    with Locations(p.part.faces().sort_by(Axis.Z)[-1]):
        Hole(2)
    with BuildSketch(Plane.YZ):
        Polygon((0, 0), (20, 0), (0, 20), align=None)
    extrude(amount=80)
part = p.part
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
- Or select the face it sits on: the top is `part.faces().sort_by(Axis.Z)[-1]`, the front is `part.faces().sort_by(Axis.Y)[0]`, and `with BuildPart(top)` builds on that face.
- Keep every existing part unchanged. Add the feature with `+`.

```python
base_t = 5
base = Box(80, 40, base_t, align=(Align.MIN, Align.MIN, Align.MIN))
edit_top = base.faces().sort_by(Axis.Z)[-1]
edit_front = base.faces().sort_by(Axis.Y)[0]
feature = Pos(0, 0, base_t) * Box(10, 10, 4, align=(Align.MIN, Align.MIN, Align.MIN))
edited = base + feature
with BuildPart(edit_top):
    Cylinder(2, 6, align=(Align.MIN, Align.MIN, Align.MIN))
assert edit_front is not None and edited.volume > base.volume
```
