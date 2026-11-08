import pg from 'pg';

export function parseNumeric(val: string | null): number | null {
  if (val === null || val === undefined) return null;
  return Number(val);
}

export function parseInt8(val: string | null): number | null {
  if (val === null || val === undefined) return null;
  return Number(val);
}

export function parseTimestamptz(val: string | null): number | null {
  if (val === null || val === undefined) return null;
  return new Date(val).getTime();
}

/** Parser table for PGlite */
export const pgliteParsers: Record<number, (val: string) => unknown> = {
  1700: parseNumeric,
  20: parseInt8,
  1184: parseTimestamptz,
};

export const parsers = pgliteParsers;

/** Builds a types object for a pg.Pool */
export function createPgTypes(): pg.CustomTypesConfig {
  return {
    getTypeParser: (id: number, format?: Parameters<typeof pg.types.getTypeParser>[1]) => {
      if (id === 1700) return parseNumeric;
      if (id === 20) return parseInt8;
      if (id === 1184) return parseTimestamptz;
      return pg.types.getTypeParser(id, format);
    },
  };
}

export const pgTypes = createPgTypes();
