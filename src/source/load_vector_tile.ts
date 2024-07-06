// @ts-expect-error - TS2300 - Duplicate identifier 'VectorTile'.
import { VectorTile } from "@mapbox/vector-tile";
import Protobuf from "pbf";
import { getArrayBuffer } from "../util/ajax";
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
  queuedKeys: Set<string>;
  scheduler: Scheduler | null | undefined;

  constructor(scheduler?: Scheduler) {
    this.entries = {};
    this.scheduler = scheduler;
    this.queuedKeys = new Set();
  }

  request(
    key: string,
    metadata: any,
    requestFunc: any,
    callback: LoadVectorDataCallback
  ): () => void {
    const entry = (this.entries[key] = this.entries[key] || { callbacks: [] });

    const removeCallbackFromEntry = ({ key, requestCallback }) => {
      const entry = this.entries[key];
      if (entry.result) return;
      entry.callbacks = entry.callbacks.filter((cb) => cb !== requestCallback);
      if (!entry.callbacks.length) {
        console.log("all callbacks removed, time to cancel entry", entry);
        entry.cancel();
        delete this.entries[key];
      }
    };

    let advanced = false;
    const advanceImageRequestQueue = () => {
      if (advanced) {
        console.log("aborting queue advancement because advanced flag is set");
        return;
      }
      console.log(
        "proceeding with queue advancement",
        numImageRequests,
        imageQueue.length
      );
      advanced = true;
      numImageRequests--;
      assert(numImageRequests >= 0);
      while (imageQueue.length && numImageRequests < 1) {
        // eslint-disable-line
        const request = imageQueue.shift();
        const { key, metadata, requestFunc, callback, cancelled } = request;
        if (!cancelled) {
          request.cancel = this.request(key, metadata, requestFunc, callback);
        } else {
          removeCallbackFromEntry({
            key,
            requestCallback: callback,
          });
        }
      }
    };

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

    if (!entry.requested) {
      // No cancel function means this is the first request for this resource

      if (numImageRequests >= 1) {
        const queued = {
          key,
          metadata,
          requestFunc,
          callback,
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
        };
        imageQueue.push(queued);
        entry.cancel = () => {
          imageQueue.forEach(
            (queueItem) => queueItem?.key === key && queueItem.cancel()
          );
        };
        return queued.cancel;
      }
      numImageRequests++;

      const actualRequestCancel = requestFunc((err, result) => {
        console.log("getArrayBuffer completed successfully", entry);
        advanceImageRequestQueue();
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
      entry.cancel = actualRequestCancel;

      // Using requested flag here in case some requests are being missed due to addition of cancel handler when queueing
      entry.requested = true;
    }

    return () => {
      removeCallbackFromEntry({
        key,
        requestCallback: callback,
      });
    };
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
