const lookup = (obj, value: string) => {
  if (obj.hasOwnProperty(value)) {
    return obj[value];
  }
  throw new Error(`key not found ${value}`);
};

export { lookup };
