export function requiredValue<T>(
  value: T | null | undefined,
  label: string,
): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be present.`);
  }
  return value;
}

export function firstRow<T>(rows: readonly T[], label = "a row"): T {
  return rowAt(rows, 0, label);
}

export function onlyRow<T>(rows: readonly T[], label = "a row"): T {
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${rows.length}.`);
  }
  return rowAt(rows, 0, label);
}

export function rowAt<T>(
  rows: readonly T[],
  index: number,
  label = "a row",
): T {
  if (index < 0 || index >= rows.length) {
    throw new Error(
      `Expected ${label} at index ${index}; found ${rows.length}.`,
    );
  }
  const row = rows[index];
  if (row === undefined)
    throw new Error(`Expected ${label} at index ${index}.`);
  return row;
}

export function countFor(
  counts: Readonly<Record<string, number>>,
  name: string,
): number {
  return requiredValue(counts[name], `a count for ${name}`);
}
