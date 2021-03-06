import * as t from "io-ts"
import * as D from "io-ts/lib/Decoder";
import * as Either from "fp-ts/lib/Either";
import * as B from "../basics";
import debug from "debug";

const d = debug("validation:environment");

export interface AWSAccessKeyBrand {
    readonly AWSAccessKey: unique symbol
}

export interface AWSSecretKeyBrand {
    readonly AWSSecretKey: unique symbol
}

// Ensure key and secret are either both set and in proper format, or both unset.
export const Env = D.union(
    D.type({
        AWS_ACCESS_KEY: D.refine(
            (s: string): s is t.Branded<string, AWSAccessKeyBrand> =>
                /(?<![A-Z0-9])[A-Z0-9]{20}(?![A-Z0-9])/.test(s),
            "AWSAccessKey"
        )(D.string),
        AWS_SECRET_KEY: D.refine(
            (s: string): s is t.Branded<string, AWSSecretKeyBrand> =>
                /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/.test(s),
            "AWSSecretKey"
        )(D.string),
    }),
    D.type({
        AWS_ACCESS_KEY: B.undef,
        AWS_SECRET_KEY: B.undef,
    }),
);

export type Env = D.TypeOf<typeof Env>;

export const validateEnvironment = (unsafeEnv: unknown): Env | null => {
    const result = Env.decode(unsafeEnv);
    return Either.getOrElseW(
        (e: D.DecodeError) => {
            d(`FATAL - Unable to validate command line options: ${D.draw(e)}`);
            return null;
        },
    )(result);
};

