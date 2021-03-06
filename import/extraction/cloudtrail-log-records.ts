import {
    ListObjectsV2Output,
    ListObjectsV2Request,
    Object
} from "aws-sdk/clients/s3";
import {CloudtrailLog, CloudtrailLogRecord} from "../types/log/cloudtrail-log";
import * as AWS from "aws-sdk";
import debug from "debug";
import {ExtractionParams} from "./params";
import {Client as ESClient} from "@elastic/elasticsearch";
import * as zlib from "zlib";
import * as Either from "fp-ts/lib/Either";
import {error, DecodeError} from "io-ts/lib/Decoder";
import {getId} from "../common/get-id";
import {Readable} from "stream";
import {Merge} from "../common/merge";
import moment from "moment";

/**
 * List all S3 objects at a given prefix
 *
 * @param s3 {AWS.S3} S3 Client
 * @param bucket {string} The S3 bucket name
 * @param prefix {string} The S3 prefix ("folder") to search
 * @yield {AWS.S3.Object} An S3 Object
 * @throws If there was a problem in the S3 call
 */
const listS3Objs = async function* (s3: AWS.S3, bucket: string, prefix: string): AsyncIterable<Object> {
    const d = debug("listS3Objs");

    const params: ListObjectsV2Request = {Bucket: bucket, Prefix: prefix};

    try {
        let objs: ListObjectsV2Output;
        do {
            /* fetch a list of all the objects to be processed based on the prefix */
            d("Fetching %s with marker: %s", prefix, params.ContinuationToken);
            objs = await s3.listObjectsV2(params).promise();
            if (objs.Contents) {
                if (objs.NextContinuationToken) {
                    params.ContinuationToken = objs.NextContinuationToken;
                }
                for (const obj of objs.Contents) {
                    yield obj;
                }
            }
        } while (objs.NextContinuationToken);
    } catch (e) {
        d("ERROR: %s", e);
        throw e;
    }
};

/**
 * Check if an S3 object has already been imported
 * @param es {ESClient} Elasticsearch client
 * @param workIndex {string} Elasticsearch work index
 * @param bucket {string} S3 bucket of the key to mark in Elasticsearch
 * @param key {string} S3 key to search in Elasticsearch
 * @param etag {string} latest S3 etag to compare to Elasticsearch
 * @return {Promise<boolean>} Promise of whether the object is already imported.
 */
export const alreadyFinished = async (es: ESClient, workIndex: string, bucket: string, key: string, etag: string): Promise<boolean> => {
    const d = debug("alreadyFinished");
    const id = getId(bucket, key);
    const res = await es.get({ id, index: workIndex }, { ignore: [404] });
    if (res.statusCode === 200) {
        return res.body._source.etag === etag;
    }
    if (res.statusCode !== 404) {
        d(`Error looking up ${id}: ${res.statusCode} ${res.body}`);
        return false;
    }
    return false;
};

/**
 * Mark that we are finished importing an S3 object
 * @param es {ESClient} Elasticsearch client
 * @param workIndex {string} Elasticsearch work index
 * @param bucket {string} S3 bucket of the key to mark in Elasticsearch
 * @param key {string} S3 key to mark in Elasticsearch
 * @param etag {string} latest S3 etag to write in Elasticsearch
 */
export const markFinished = async (es: ESClient, workIndex: string, bucket: string, key: string, etag: string): Promise<void> => {
    await es.index({
        index: workIndex,
        id: getId(bucket, key),
        body: {
            key: key,
            etag: etag,
            timestamp: moment().format(),
        }
    });
};

/**
 * Read a GZipped object from S3
 * @param s3 {AWS.S3} The S3 Client
 * @param bucket {string} The S3 Bucket
 * @param key {string} The key of the object in the bucket
 * @return A NodeJS stream of the unzipped S3 object.
 */
export const readGzipS3Stream = (s3: AWS.S3, bucket: string, key: string): Readable =>
    s3.getObject({
        Bucket: bucket,
        Key: key,
    })
    .createReadStream()
    .pipe(zlib.createGunzip());

/**
 * Asynchronously read a NodeJS stream
 * @param readable {Readable} A NodeJS stream
 * @return {Promise<string>} A promise of the complete stream in memory.
 */
export const readAll = async (readable: Readable): Promise<string> => {
    let body = "";
    for await(const data of readable) {
        body += data;
    }
    return body;
};

/**
 * Parse cloudtrail log entries from a raw JSON string.
 * @param key {string} The S3 Key (for error messages)
 * @param jsonSrc {string} The JSON to parse
 * @return {CloudtrailLog | null} The parsed log, or null (accompanied by an error
 *                                message in the batch log) if parse failed.
 */
export const parseCloudtrailLog = (key: string, jsonSrc: string): CloudtrailLog | null => {
    const d = debug("parseCloudtrailLog");
    let json: Either.Either<DecodeError, unknown>;
    try {
        json = Either.parseJSON(jsonSrc, e => error(jsonSrc, `${e}`));
    } catch (e) {
        d(`Error parsing S3 log at ${key}: ${e}`);
        return null;
    }
    const validation = Either.chain(CloudtrailLog.decode)(json);
    return Either.getOrElseW((e: DecodeError) => {
        d(`S3 log invalid at ${key}: ${e}`);
        return null;
    })(validation);
};

/**
 * Ensures the work index exists
 *
 * @method ensureWorkIndex
 * @param {ESClient} ES initialized Elastical.Client
 * @param {String} workIndexName name of index for keeping track of processed objects
 * @return {Promise<void>}
 */
const ensureWorkIndex = async (ES: ESClient, workIndexName: string) => {
    const d = debug("ensureWorkIndex");
    const indices = ES.indices;
    const workIndex = await indices.exists({index: workIndexName});

    const makeWorkIndex = () =>
        ES.indices.create({
            index: workIndexName,
            body: {
                mappings: {
                    properties: {
                        eventTime: {type: "date"}
                    }
                }
            },
        });

    if (workIndex.body) {
        d(`${workIndexName} exists`);
    } else {
        await makeWorkIndex();
    }
};

/** Yields all records in an S3 object.
 *
 * @param s3 {AWS.S3}
 * @param es {ESClient}
 * @param workIndex {string} The Elasticsearch Work Index (for marking progress)
 * @param bucket {string} The S3 Bucket
 * @yield {CloudtrailLogRecord} The records in the S3 Object
 */
const eachRecord =
    (s3: AWS.S3, es: ESClient, workIndex: string, bucket: string) =>
    async function*(obj: {Key?: string | undefined, ETag?: string | undefined}): AsyncIterable<CloudtrailLogRecord> {
        const d = debug("eachRecord");

        const key: string | undefined = obj.Key;
        const etag: string | undefined = obj.ETag;
        if (!key) {
            d(`Object ${obj} has no key; this should never happen.`);
        } else if (!etag) {
            d(`Object ${obj} has no ETag; this should never happen.`);
        } else if (await alreadyFinished(es, workIndex, bucket, key, etag)) {
            d(`Skip ${obj.Key}; already exists.`);
        } else {
            d(`Processing ${key}`);
            const jsonSrc = await readAll(readGzipS3Stream(s3, bucket, key));
            const log: CloudtrailLog | null = parseCloudtrailLog(key, jsonSrc);

            if (log) {
                for (const record of log.Records) {
                    yield {...record};
                }
                await markFinished(es, workIndex, bucket, key, etag);
            }
        }
    };

/**
 * Extract all log records from an S3 bucket at a specified prefix. Mark each
 * log file complete in Elasticsearch when it completes.
 *
 * @param merge {Merge} An implementation of Merge on multiple AsyncIterators.
 * @param workIndex {string} The Elasticsearch Work Index (for marking progress)
 * @param bucket {string} The S3 Bucket
 * @param prefix {string} The S3 Prefix ("folder") to search
 * @param s3 {AWS.S3} S3 Client
 * @param es {ESClient} Elasticsearch Client
 */
export const cloudtrailLogRecordExtractor =
    (merge: Merge) =>
    ({workIndex, bucket, prefix, s3, es}: ExtractionParams) =>
    async function*(): AsyncIterable<CloudtrailLogRecord> {
        await ensureWorkIndex(es, workIndex);
        yield* merge(eachRecord(s3, es, workIndex, bucket))(listS3Objs(s3, bucket, prefix));
    };

export const _private = {
    listS3Objs,
    alreadyFinished,
    markFinished,
    readGzipS3Stream,
    readAll,
    parseCloudtrailLog,
    ensureWorkIndex,
    eachRecord,
};
