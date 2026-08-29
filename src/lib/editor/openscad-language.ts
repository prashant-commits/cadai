import type { languages } from 'monaco-editor';

export const OPENSCAD_LANGUAGE_ID = 'openscad';

export const openscadLanguageDef: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.scad',

  keywords: [
    'module',
    'function',
    'if',
    'else',
    'for',
    'intersection_for',
    'let',
    'assign',
    'include',
    'use',
    'true',
    'false',
    'undef',
  ],

  primitives: [
    'cube',
    'sphere',
    'cylinder',
    'polyhedron',
    'square',
    'circle',
    'polygon',
    'text',
  ],

  transformations: [
    'translate',
    'rotate',
    'scale',
    'resize',
    'mirror',
    'multmatrix',
    'color',
    'offset',
    'hull',
    'minkowski',
    'linear_extrude',
    'rotate_extrude',
    'projection',
    'render',
    'union',
    'difference',
    'intersection',
  ],

  specialVariables: [
    '$fa',
    '$fs',
    '$fn',
    '$t',
    '$vpr',
    '$vpt',
    '$vpd',
    '$children',
    '$preview',
  ],

  mathFunctions: [
    'abs',
    'sign',
    'sin',
    'cos',
    'tan',
    'acos',
    'asin',
    'atan',
    'atan2',
    'floor',
    'round',
    'ceil',
    'ln',
    'log',
    'pow',
    'sqrt',
    'exp',
    'rands',
    'min',
    'max',
    'concat',
    'lookup',
    'str',
    'chr',
    'search',
    'version',
    'version_num',
    'parent_module',
    'norm',
    'cross',
  ],

  operators: [
    '=',
    '>',
    '<',
    '!',
    '~',
    '?',
    ':',
    '==',
    '<=',
    '>=',
    '!=',
    '&&',
    '||',
    '++',
    '--',
    '+',
    '-',
    '*',
    '/',
    '&',
    '|',
    '^',
    '%',
  ],

  symbols: /[=><!~?:&|+\-*\/\^%]+/,

  tokenizer: {
    root: [
      // Identifiers and keywords
      [
        /\$[a-zA-Z_]\w*/,
        {
          cases: {
            '@specialVariables': 'variable.predefined',
            '@default': 'variable',
          },
        },
      ],
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@primitives': 'type',
            '@transformations': 'keyword.flow',
            '@mathFunctions': 'support.function',
            '@default': 'identifier',
          },
        },
      ],

      // Whitespace
      { include: '@whitespace' },

      // Delimiters and operators
      [/[{}()\[\]]/, '@brackets'],
      [/[<>](?!@symbols)/, '@brackets'],
      [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],

      // Numbers
      [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
      [/0[xX][0-9a-fA-F]+/, 'number.hex'],
      [/\d+/, 'number'],

      // Strings
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, { token: 'string.quote', bracket: '@open', next: '@string' }],
    ],

    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
    ],

    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],
    ],

    comment: [
      [/[^\/*]+/, 'comment'],
      [/\/\*/, 'comment', '@push'],
      ["\\*/", 'comment', '@pop'],
      [/[\/*]/, 'comment'],
    ],
  },
};
