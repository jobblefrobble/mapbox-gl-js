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
export class DedupedRequest {
  entries: {
    [key: string]: any;
  };
  scheduler: Scheduler | null | undefined;

  constructor(scheduler?: Scheduler) {
    this.entries = {};
    this.scheduler = scheduler;
  }

  request(
    key: string,
    metadata: any,
    request: any,
    callback: LoadVectorDataCallback
  ): () => void {
    const entry = (this.entries[key] = this.entries[key] || { callbacks: [] });

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
        console.log("about to call makeRequest for entry with not cancel function", entry)
      entry.cancel = request((err, result) => {
        entry.result = [err, result];
        for (const cb of entry.callbacks) {
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

    return () => {
      if (entry.result) return;
      entry.callbacks = entry.callbacks.filter((cb) => cb !== callback);
      if (!entry.callbacks.length) {
        entry.cancel();
        delete this.entries[key];
      }
    };
  }
}

let imageQueue, numImageRequests;
export const resetImageRequestQueue = () => {
  imageQueue = [];
  numImageRequests = 0;
};
resetImageRequestQueue();

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
    console.log(
      "makeRequest",
      "numImageRequests",
      numImageRequests,
      "imageQueue",
      imageQueue.length
    );
    // limit concurrent image loads to help with raster sources performance on big screens
    if (numImageRequests >= 2) {
      const queued = {
        params,
        callback,
        cancelled: false,
        skipParse,
        cancel() {
          this.cancelled = true;
        },
      };
      imageQueue.push(queued);
      return queued;
    }
    numImageRequests++;

    let advanced = false;
    const advanceImageRequestQueue = () => {
      if (advanced) {
        console.log(
          "returning early because already advanced",
          numImageRequests,
          imageQueue.length
        );
        return;
      }
      console.log(
        "not advanced, so proceeding",
        numImageRequests,
        imageQueue.length
      );
      advanced = true;
      numImageRequests--;
      assert(numImageRequests >= 0);
      while (imageQueue.length && numImageRequests < 2) {
        // eslint-disable-line
        const requestFromQueue = imageQueue.shift();
        const { params, callback, cancelled, skipParse } = requestFromQueue;
        console.log("requestFromQueue", requestFromQueue);
        if (!cancelled) {
          //   loadVectorTile(params, callback, skipParse);
          requestFromQueue.cancel = makeRequest(callback);
        }
      }
    };

    const request = getArrayBuffer(
      params.request,
      (
        err?: Error | null,
        data?: ArrayBuffer | null,
        cacheControl?: string | null,
        expires?: string | null
      ) => {
        advanceImageRequestQueue();

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
      advanceImageRequestQueue();
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
