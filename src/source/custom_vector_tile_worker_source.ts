import {getJSON} from '../util/ajax';

import {RequestPerformance} from '../util/performance';
import rewind from '@mapbox/geojson-rewind';
import GeoJSONWrapper from './geojson_wrapper';
import vtpbf from 'vt-pbf';
import geojsonvt from 'geojson-vt';
import VectorTileWorkerSource from './vector_tile_worker_source';

import type {
    WorkerTileParameters,
    WorkerTileCallback,
} from '../source/worker_source';

import type Actor from '../util/actor';
import type StyleLayerIndex from '../style/style_layer_index';

import type {LoadVectorDataCallback} from './vector_tile_worker_source';
import type {RequestParameters, ResponseCallback} from '../util/ajax';
import type {Callback} from '../types/callback';
import type {Cancelable} from '../types/cancelable';

export type LoadGeoJSONParameters = {
    request?: RequestParameters;
    data?: string;
    source: string;
    cluster: boolean;
    superclusterOptions?: any;
    geojsonVtOptions?: any;
    clusterProperties?: any;
    filter?: Array<unknown>;
};

export type LoadGeoJSON = (params: LoadGeoJSONParameters, callback: ResponseCallback<any>) => Cancelable;

interface VectorTilePlugin {
    getTile(z: number, x: number, y: number): any;
}

function loadTile(params: WorkerTileParameters, callback: LoadVectorDataCallback): (() => void) | void {
    const canonical = params.tileID.canonical;

    if (!this._vectorTilePlugin) {
        return callback(null, null);
    }

    const geoJSONTile = this._vectorTilePlugin.getTile(canonical.z, canonical.x, canonical.y);
    if (!geoJSONTile) {
        return callback(null, null);
    }

    const geojsonWrapper = new GeoJSONWrapper(geoJSONTile.features);

    // Encode the geojson-vt tile into binary vector tile form.  This
    // is a convenience that allows `FeatureIndex` to operate the same way
    // across `VectorTileSource` and `GeoJSONSource` data.
    let pbf = vtpbf(geojsonWrapper);
    if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
        // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
        pbf = new Uint8Array(pbf);
    }

    callback(null, {
        vectorTile: geojsonWrapper,
        rawData: pbf.buffer
    });
}

class CustomVectorTileWorkerSource extends VectorTileWorkerSource {
    _pendingCallback: Callback<{
        resourceTiming?: {[_: string]: Array<PerformanceResourceTiming>};
        abandoned?: boolean;
    }>;
    _pendingRequest: Cancelable;
    _vectorTilePlugin: VectorTilePlugin;

    constructor(actor: Actor, layerIndex: StyleLayerIndex, availableImages: Array<string>, loadGeoJSON?: LoadGeoJSON | null) {
        super(actor, layerIndex, availableImages, loadTile);
        if (loadGeoJSON) {
            this.loadGeoJSON = loadGeoJSON;
        }
    }

    loadData(params: LoadGeoJSONParameters, callback: Callback<{
        resourceTiming?: {[_: string]: Array<PerformanceResourceTiming>};
        abandoned?: boolean;
    }>) {
        this._pendingRequest?.cancel();
        if (this._pendingCallback) {
            // Tell the foreground the previous call has been abandoned
            this._pendingCallback(null, {abandoned: true});
        }

        const perf = (params && params.request && params.request.collectResourceTiming) ?
            new RequestPerformance(params.request) : false;

        this._pendingCallback = callback;
        this._pendingRequest = this.loadGeoJSON(params, (err?: Error | null, data?: any | null) => {
            delete this._pendingCallback;
            delete this._pendingRequest;

            if (err || !data) {
                return callback(err);
            } else if (typeof data !== 'object') {
                return callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
            } else {
                rewind(data, true);

                try {
                    this._vectorTilePlugin = geojsonvt(data, params.geojsonVtOptions);   
                } catch (err) {
                    return callback(err);
                }

                this.loaded = {};

                const result = {} as { resourceTiming: any };
                if (perf) {
                    const resourceTimingData = perf.finish();
                    // it's necessary to eval the result of getEntriesByName() here via parse/stringify
                    // late evaluation in the main thread causes TypeError: illegal invocation
                    if (resourceTimingData) {
                        result.resourceTiming = {};
                        result.resourceTiming[params.source] = JSON.parse(JSON.stringify(resourceTimingData));
                    }
                }
                callback(null, result);
            }
        });
    }

    reloadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
        const loaded = this.loaded,
            uid = params.uid;

        if (loaded && loaded[uid]) {
            return super.reloadTile(params, callback);
        } else {
            return this.loadTile(params, callback);
        }
    }

    loadGeoJSON(params: LoadGeoJSONParameters, callback: ResponseCallback<any>): Cancelable {
        // Because of same origin issues, urls must either include an explicit
        // origin or absolute path.
        // ie: /foo/bar.json or http://example.com/bar.json
        // but not ../foo/bar.json
        if (params.request) {
            return getJSON(params.request, callback);
        } else if (typeof params.data === 'string') {
            try {
                callback(null, JSON.parse(params.data));
            } catch (e) {
                callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
            }
        } else {
            callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
        }

        return {cancel: () => {}};
    }

    removeSource(params: { source: string }, callback: WorkerTileCallback) {
        if (this._pendingCallback) {
            // Don't leak callbacks
            this._pendingCallback(null, {abandoned: true});
        }
        callback();
    }
}

export default CustomVectorTileWorkerSource;
