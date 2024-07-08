/* eslint-disable object-curly-spacing */
/* eslint-disable indent */
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

  addToSchedulerOrCallDirectly({
    callback,
    metadata,
    err,
    result,
  }: {
    callback: LoadVectorDataCallback;
    metadata: any;
    err: Error | null | undefined;
    result: any;
  }) {
    if (this.scheduler) {
      this.scheduler.add(() => {
        callback(err, result);
      }, metadata);
    } else {
      callback(err, result);
    }
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
      console.log("advancing queue", numImageRequests, imageQueue.length);
      advanced = true;
      numImageRequests--;
      assert(numImageRequests >= 0);
      while (imageQueue.length && numImageRequests < 1) {
        // eslint-disable-line
        const request = imageQueue.shift();
        const { key, metadata, requestFunc, callback, cancelled } = request;
        if (!cancelled) {
          console.log("requesting from queue", turnKeyIntoTileCoords(key));
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
      this.addToSchedulerOrCallDirectly({ callback, metadata, err, result });
      return () => {};
    }

    entry.callbacks.push(callback);

    // Think this might be the crux of tiles getting missed! If we attach cancel
    // If more requests come in before queued request is being brought in and clog the queue again
    if (!entry.cancel) {
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
        console.log(
          "getArrayBuffer completed successfully",
          turnKeyIntoTileCoords(key)
        );
        advanceImageRequestQueue();
        entry.result = [err, result];
        for (const cb of entry.callbacks) {
          this.addToSchedulerOrCallDirectly({
            callback: cb,
            metadata,
            err,
            result,
          });
        }
        // Maybe need to clear out the queue too here?
        setTimeout(() => delete this.entries[key], 1000 * 3);
      });
      entry.cancel = actualRequestCancel;
    }

    return () => {
      removeCallbackFromEntry({
        key,
        requestCallback: callback,
      });
    };
  }
}

const turnKeyIntoTileCoords = (key: string) => {
  const splitByPbf = key.split(".pbf");
  const splitBySlash = splitByPbf[0].split("/");
  const z = splitBySlash[splitBySlash.length - 3];
  const x = splitBySlash[splitBySlash.length - 2];
  const y = splitBySlash[splitBySlash.length - 1].split(".")[0];
  return { z, x, y };
};

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
