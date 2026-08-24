export type CanonicalIdentifier = string & {
  readonly canonicalIdentifier: unique symbol;
};
