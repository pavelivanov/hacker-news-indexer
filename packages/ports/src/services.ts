export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(milliseconds: number): Promise<void>;
}

export interface Hasher {
  sha256(value: string): string;
}

export interface RandomSource {
  fraction(): number;
}
