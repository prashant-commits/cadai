// Names a spec identifier must never take, because the emitted script uses or
// inherits them. Regenerate with the snippet in python-names.test.ts when the
// pinned build123d changes (the test fails if this drifts from the interpreter).

/** Python keywords and soft keywords. */
export const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', '_', 'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'type',
  'while', 'with', 'yield',
]);

/** Public Python builtins. */
export const PYTHON_BUILTINS: ReadonlySet<string> = new Set([
  'ArithmeticError', 'AssertionError', 'AttributeError', 'BaseException', 'BaseExceptionGroup',
  'BlockingIOError', 'BrokenPipeError', 'BufferError', 'BytesWarning', 'ChildProcessError',
  'ConnectionAbortedError', 'ConnectionError', 'ConnectionRefusedError', 'ConnectionResetError',
  'DeprecationWarning', 'EOFError', 'Ellipsis', 'EncodingWarning', 'EnvironmentError', 'Exception',
  'ExceptionGroup', 'False', 'FileExistsError', 'FileNotFoundError', 'FloatingPointError', 'FutureWarning',
  'GeneratorExit', 'IOError', 'ImportError', 'ImportWarning', 'IndentationError', 'IndexError',
  'InterruptedError', 'IsADirectoryError', 'KeyError', 'KeyboardInterrupt', 'LookupError', 'MemoryError',
  'ModuleNotFoundError', 'NameError', 'None', 'NotADirectoryError', 'NotImplemented',
  'NotImplementedError', 'OSError', 'OverflowError', 'PendingDeprecationWarning', 'PermissionError',
  'ProcessLookupError', 'RecursionError', 'ReferenceError', 'ResourceWarning', 'RuntimeError',
  'RuntimeWarning', 'StopAsyncIteration', 'StopIteration', 'SyntaxError', 'SyntaxWarning', 'SystemError',
  'SystemExit', 'TabError', 'TimeoutError', 'True', 'TypeError', 'UnboundLocalError', 'UnicodeDecodeError',
  'UnicodeEncodeError', 'UnicodeError', 'UnicodeTranslateError', 'UnicodeWarning', 'UserWarning',
  'ValueError', 'Warning', 'ZeroDivisionError', 'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin',
  'bool', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
  'copyright', 'credits', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'exit',
  'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id',
  'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'license', 'list', 'locals', 'map', 'max',
  'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'quit', 'range',
  'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super',
  'tuple', 'type', 'vars', 'zip',
]);

/** Public names of the math module; the script prelude binds them for model bodies. */
export const MATH_NAMES: ReadonlySet<string> = new Set([
  'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt', 'ceil', 'comb', 'copysign', 'cos',
  'cosh', 'degrees', 'dist', 'e', 'erf', 'erfc', 'exp', 'exp2', 'expm1', 'fabs', 'factorial', 'floor',
  'fmod', 'frexp', 'fsum', 'gamma', 'gcd', 'hypot', 'inf', 'isclose', 'isfinite', 'isinf', 'isnan',
  'isqrt', 'lcm', 'ldexp', 'lgamma', 'log', 'log10', 'log1p', 'log2', 'modf', 'nan', 'nextafter', 'perm',
  'pi', 'pow', 'prod', 'radians', 'remainder', 'sin', 'sinh', 'sqrt', 'sumprod', 'tan', 'tanh', 'tau',
  'trunc', 'ulp',
]);

/** Everything `from build123d import *` binds. */
export const BUILD123D_NAMES: ReadonlySet<string> = new Set([
  'Airfoil', 'Align', 'AngularDirection', 'ApproxOption', 'Arrow', 'ArrowHead', 'Axis', 'BSpline',
  'BallJoint', 'BaseCurveObject', 'BaseEdgeObject', 'BaseLineObject', 'BasePartObject', 'BaseSketchObject',
  'Bezier', 'BlendCurve', 'BoundBox', 'Box', 'BuildLine', 'BuildPart', 'BuildSketch', 'CM', 'CenterArc',
  'CenterOf', 'Circle', 'Color', 'Compound', 'Cone', 'ConstrainedArcs', 'ConstrainedLines',
  'ContinuityLevel', 'ConvexPolyhedron', 'Convexity', 'CounterBoreHole', 'CounterSinkHole', 'Curve',
  'Cylinder', 'CylindricalJoint', 'DimensionLine', 'DotLength', 'DoubleTangentArc', 'Draft',
  'DraftAngleError', 'Edge', 'Ellipse', 'EllipticalCenterArc', 'EllipticalStartArc', 'Export2D',
  'ExportDXF', 'ExportSVG', 'ExtensionLine', 'Extrinsic', 'FT', 'Face', 'FilletPolyline', 'FontManager',
  'FontStyle', 'FrameMethod', 'G', 'G_PER_LB', 'GeomEncoder', 'GeomType', 'GridLocations', 'HeadType',
  'Helix', 'HexLocations', 'Hole', 'HyperbolicCenterArc', 'IN', 'IntersectingLine', 'Intrinsic', 'JernArc',
  'Joint', 'KG', 'Keep', 'Kind', 'LB', 'LengthMode', 'Line', 'LineType', 'LinearJoint', 'Location',
  'Locations', 'M', 'MC', 'MM', 'Matrix', 'MeshType', 'Mesher', 'Mode', 'NumberDisplay',
  'OrientedBoundBox', 'PageSize', 'ParabolicCenterArc', 'Part', 'Plane', 'PolarLine', 'PolarLocations',
  'Polygon', 'Polyline', 'Pos', 'PositionMode', 'PrecisionMode', 'RadiusArc', 'Rectangle',
  'RectangleRounded', 'RegularPolygon', 'RevoluteJoint', 'RigidJoint', 'Rot', 'Rotation', 'RotationLike',
  'Sagitta', 'SagittaArc', 'Select', 'ShapeList', 'Shell', 'Side', 'Sketch', 'SlotArc', 'SlotCenterPoint',
  'SlotCenterToCenter', 'SlotOverall', 'Solid', 'SortBy', 'Sphere', 'Spline', 'Superellipse', 'THOU',
  'Tangency', 'TangentArc', 'TechnicalDrawing', 'Text', 'TextAlign', 'ThreePointArc', 'Torus',
  'Transition', 'Trapezoid', 'Triangle', 'UNITS_PER_KILOGRAM', 'UNITS_PER_METER', 'Unit', 'Until',
  'Vector', 'VectorLike', 'Vertex', 'Wedge', 'Wire', 'add', 'available_fonts', 'bounding_box', 'chamfer',
  'delta', 'detect_primitives', 'draft', 'edge', 'edges', 'edges_to_wires', 'export_brep', 'export_gltf',
  'export_obj', 'export_step', 'export_stl', 'export_to_pcbway', 'extrude', 'face', 'faces', 'fillet',
  'full_round', 'import_brep', 'import_dxf', 'import_step', 'import_stl', 'import_svg',
  'import_svg_as_buildline_code', 'insert', 'loft', 'make_brake_formed', 'make_face', 'make_hull',
  'mirror', 'new_edges', 'offset', 'pack', 'polar', 'project', 'project_workplane', 'revolve', 'scale',
  'section', 'solid', 'solids', 'split', 'sweep', 'thicken', 'topo_distance_to',
  'topo_explore_common_vertex', 'topo_explore_connected_edges', 'trace', 'vertex', 'vertices', 'wire',
  'wires',
]);

