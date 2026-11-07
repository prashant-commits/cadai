import pytest
from build123d import Box, Cylinder, Pos
from cadai_geo.run import compute_disconnected


def test_touching():
    b1 = Box(10, 10, 10)
    b2 = Pos(10, 0, 0) * Box(10, 10, 10)
    assert compute_disconnected([("b1", b1), ("b2", b2)]) == []


def test_point_four_mm_gap_ok():
    b1 = Box(10, 10, 10)
    b2 = Pos(10.4, 0, 0) * Box(10, 10, 10)
    assert compute_disconnected([("b1", b1), ("b2", b2)]) == []


def test_two_mm_gap_error():
    b1 = Box(10, 10, 10)
    b2 = Pos(12.0, 0, 0) * Box(10, 10, 10)
    assert compute_disconnected([("b1", b1), ("b2", b2)]) == ["b1", "b2"]


def test_pin_in_bore_ok():
    knuckle = Box(10, 10, 10) - Cylinder(2.8, 12)
    pin = Cylinder(2.0, 10)
    assert compute_disconnected([("knuckle", knuckle), ("pin", pin)]) == []


def test_pin_with_two_mm_radial_gap_error():
    # Bore diameter 8 (radius 4), pin radius 1 -> radial clearance 3mm (> 1mm)
    knuckle = Box(15, 15, 15) - Cylinder(4.0, 16)
    pin = Cylinder(1.0, 15)
    assert compute_disconnected([("knuckle", knuckle), ("pin", pin)]) == ["knuckle", "pin"]
