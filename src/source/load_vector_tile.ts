// @ts-expect-error - TS2300 - Duplicate identifier 'VectorTile'.
import { VectorTile } from "@mapbox/vector-tile";
import Protobuf from "pbf";
import { getArrayBuffer } from "../util/ajax";
import config from "../util/config";
import assert from "assert";

// @ts-expect-error - TS2300 - Duplicate identifier 'VectorTile'.
import type { VectorTile } from "@mapbox/vector-tile";
import type { Callback } from "../types/callback";
import type { RequestedTileParameters } from "./worker_source";
import type Scheduler from "../util/scheduler";

export type LoadVectorTileResult = {
  rawData: ArrayBuffer;
  vectorTile?: VectorTile;
  expires?: any;
  cacheControl?: any;
  resourceTiming?: Array<PerformanceResourceTiming>;
};

/**
 * @callback LoadVectorDataCallback
 * @param error
 * @param vectorTile
 * @private
 */
export type LoadVectorDataCallback = Callback<
  LoadVectorTileResult | null | undefined
>;

export type AbortVectorData = () => void;
export type LoadVectorData = (
  params: RequestedTileParameters,
  callback: LoadVectorDataCallback
) => AbortVectorData | null | undefined;

let imageQueue, numImageRequests;
export const resetImageRequestQueue = () => {
  imageQueue = [];
  numImageRequests = 0;
};
resetImageRequestQueue();

export class DedupedRequest {
  entries: {
    [key: string]: any;
  };
  scheduler: Scheduler | null | undefined;

  constructor(scheduler?: Scheduler) {
    this.entries = {};
    this.scheduler = scheduler;
  }

  getEntry(key: string) {
    return (this.entries[key] = this.entries[key] || { callbacks: [] });
  }

  cancelRequestsInEntry(key: string, callback: LoadVectorDataCallback) {
    const entry = this.getEntry(key);
    if (entry.result) return;
    entry.callbacks = entry.callbacks.filter((cb) => cb !== callback);
    if (!entry.callbacks.length) {
      entry.cancel();
      delete this.entries[key];
    }
  }

  request(
    key: string,
    metadata: any,
    request: any,
    callback: LoadVectorDataCallback
  ): () => void {
    const entry = this.getEntry(key);

    if (entry.result) {
      const [err, result] = entry.result;
      if (this.scheduler) {
        this.scheduler.add(() => {
          callback(err, result);
        }, metadata);
      } else {
        callback(err, result);
      }
      return () => {};
    }

    entry.callbacks.push(callback);

    if (!entry.cancel) {
      // request is an alias of makeRequest in our case
      // This is where we should have our queueing logic

      if (numImageRequests >= 2) {
        const queued = {
          key: key,
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
        };
        imageQueue.push(queued);
        return queued.cancel;
      }
      numImageRequests++;

      let advanced = false;
      const advanceImageRequestQueue = () => {
        if (advanced) return;
        advanced = true;
        numImageRequests--;
        assert(numImageRequests >= 0);
        while (imageQueue.length && numImageRequests < 2) {
          // eslint-disable-line
          const queuedObject = imageQueue.shift();
          const { key, cancelled } = queuedObject;
          if (!cancelled) {
            const entryFromQueueKey = this.getEntry(key);
            entryFromQueueKey.cancel = request((err, result) => {
              advanceImageRequestQueue();
              console.log("makeRequest callback");
              entryFromQueueKey.result = [err, result];
              console.log("err", err);
              console.log("result", result);
              for (const cb of entryFromQueueKey.callbacks) {
                if (this.scheduler) {
                  this.scheduler.add(() => {
                    cb(err, result);
                  }, metadata);
                } else {
                  cb(err, result);
                }
              }
              setTimeout(() => delete this.entries[key], 1000 * 3);
            });
          }
        }
      };
    }

    return () => this.cancelRequestsInEntry(key, callback);
  }
}

/**
 * @private
 */
export function loadVectorTile(
  params: RequestedTileParameters,
  callback: LoadVectorDataCallback,
  skipParse?: boolean
): () => void {
  const key = JSON.stringify(params.request);

  const makeRequest = (callback: LoadVectorDataCallback) => {
    // getArrayBuffer is what does the actual fetching
    const request = getArrayBuffer(
      params.request,
      (
        err?: Error | null,
        data?: ArrayBuffer | null,
        cacheControl?: string | null,
        expires?: string | null
      ) => {
        if (err) {
          callback(err);
        } else if (data) {
          callback(null, {
            vectorTile: skipParse
              ? undefined
              : new VectorTile(new Protobuf(data)),
            rawData: data,
            cacheControl,
            expires,
          });
        }
      }
    );
    return () => {
      request.cancel();
      console.log("CANCELLING ARRAY BUFFER REQUEST");
      callback();
    };
  };

  if (params.data) {
    // if we already got the result earlier (on the main thread), return it directly
    (this.deduped as DedupedRequest).entries[key] = {
      result: [null, params.data],
    };
  }

  const callbackMetadata = {
    type: "parseTile",
    isSymbolTile: params.isSymbolTile,
    zoom: params.tileZoom,
  };
  return (this.deduped as DedupedRequest).request(
    key,
    callbackMetadata,
    makeRequest,
    callback
  );
}
