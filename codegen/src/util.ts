const lookup = (obj, value: string) => {
  if (obj.hasOwnProperty(value)) {
    return obj[value];
  }
  throw new Error(`key not found ${value}`);
};

function pair<T, U>(arr1: Array<T>, arr2: Array<U>): Array<[T, U]> {
  return arr1.map((a, i) => [a, arr2[i]]);
}

function pairToMap<T extends string, U>(arr: Array<[T, U]>): object {
  return arr.reduce(
    (prev, [key, value]) => ({
      [key]: value,
      ...prev
    }),
    {}
  );
}

export { lookup, pairToMap, pair };
