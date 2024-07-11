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
import type { Cancelable } from "src/types/cancelable";

export type LoadVectorTileResult = {
  rawData: ArrayBuffer;
  vectorTile?: VectorTile;
  expires?: any;
  cacheControl?: any;
  resourceTiming?: Array<PerformanceResourceTiming>;
};

const turnKeyIntoTileCoords = (key: string) => {
  if (!key) return;
  const splitByPbf = key.split(".pbf");
  const splitBySlash = splitByPbf[0].split("/");
  const layerId = splitBySlash[splitBySlash.length - 4];
  const z = splitBySlash[splitBySlash.length - 3];
  const x = splitBySlash[splitBySlash.length - 2];
  const y = splitBySlash[splitBySlash.length - 1].split(".")[0];
  return `${layerId}/${z}/${x}/${y}`;
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
  callback: LoadVectorDataCallback,
  skipParse?: boolean,
  uid?: number
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

  addToSchedulerOrCallDirectly({
    callback,
    metadata,
    err,
    result,
    key,
  }: {
    callback: LoadVectorDataCallback;
    metadata: any;
    err: Error | null | undefined;
    result: any;
    key: string | number;
  }) {
    if (this.scheduler) {
      this.scheduler.add(
        () => {
          callback(err, result);
        },
        metadata,
        key
      );
    } else {
      callback(err, result);
    }
  }

  getEntry = (key: string) => {
    return (
      this.entries[key] || {
        // use a set to avoid duplicate callbacks being added when calling from queue
        callbacks: new Set(),
      }
    );
  };

  request(
    key: string,
    metadata: any,
    requestFunc: any,
    callback: LoadVectorDataCallback,
    fromQueue?: boolean,
    uid?: number
  ): Cancelable {
    const entry = (this.entries[key] = this.getEntry(key));

    const filterQueue = (key) => {
      for (let i = imageQueue.length - 1; i >= 0; i--) {
        if (imageQueue[i].key === key) {
          imageQueue.splice(i, 1);
        }
      }
    };

    const removeCallbackFromEntry = ({ key, requestCallback, tileId }) => {
      const entry = this.getEntry(key);
      if (entry.result) return;
      entry.callbacks.delete(requestCallback);
      if (entry.callbacks.size) {
        return;
      }
      if (entry.cancel) {
        entry.cancel();
      }
      filterQueue(key);
      delete this.entries[key];
    };

    let advanced = false;
    const advanceImageRequestQueue = () => {
      if (advanced) {
        return;
      }
      advanced = true;
      numImageRequests--;
      assert(numImageRequests >= 0);
      while (imageQueue.length && numImageRequests < 50) {
        // eslint-disable-line
        const request = imageQueue.shift();
        const { key, metadata, requestFunc, callback, cancelled, uid } =
          request;
        if (!cancelled) {
          request.cancel = this.request(
            key,
            metadata,
            requestFunc,
            callback,
            true,
            uid
          );
        } else {
          filterQueue(key);
        }
      }
    };

    if (entry.result) {
      const [err, result] = entry.result;
      this.addToSchedulerOrCallDirectly({
        callback,
        metadata,
        err,
        result,
        key: uid,
      });
      return { cancel: () => {} };
    }
    entry.callbacks.add(callback);

    const inQueue = imageQueue.some((queued) => queued.key === key);
    if ((!entry.cancel && !inQueue) || fromQueue) {
      // Lack of attached cancel handler means this is the first request for this resource
      if (numImageRequests >= 50) {
        const queued = {
          key,
          metadata,
          requestFunc,
          callback,
          cancelled: false,
          uid,
          cancel() {},
        };
        const cancelFunc = () => {
          queued.cancelled = true;
          removeCallbackFromEntry({
            key,
            requestCallback: callback,
            tileId: uid,
          });
        };
        queued.cancel = cancelFunc;
        imageQueue.push(queued);
        return queued;
      }
      numImageRequests++;

      const actualRequestCancel = requestFunc((err, result) => {
        entry.result = [err, result];

        // Notable difference here compared to previous deduper, no longer iterating through callbacks stored on the entry
        // Due to intermittent errors thrown when duplicate arrayBuffers get added to the scheduling
        this.addToSchedulerOrCallDirectly({
          callback,
          metadata,
          err,
          result,
          key: uid,
        });

        filterQueue(key);
        advanceImageRequestQueue();

        setTimeout(() => {
          delete this.entries[key];
        }, 1000 * 3);
      });
      entry.cancel = () => {
        actualRequestCancel();
      };
    }

    return {
      cancel() {
        removeCallbackFromEntry({
          key,
          requestCallback: callback,
          tileId: uid,
        });
      },
    };
  }
}

/**
 * @private
 */
export function loadVectorTile(
  params: RequestedTileParameters,
  callback: LoadVectorDataCallback,
  skipParse?: boolean,
  uid?: number
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

  const dedupedAndQueuedRequest = (this.deduped as DedupedRequest).request(
    key,
    callbackMetadata,
    makeRequest,
    callback,
    false,
    uid
  );

  return dedupedAndQueuedRequest.cancel;
}
