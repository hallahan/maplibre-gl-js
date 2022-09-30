import {Event, ErrorEvent, Evented} from '../util/evented';

import {extend} from '../util/util';
import EXTENT from '../data/extent';
import {ResourceType} from '../util/ajax';
import browser from '../util/browser';

import type {Source} from './source';
import type Map from '../ui/map';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import type Actor from '../util/actor';
import type {Callback} from '../types/callback';
import type {CustomVectorTileSourceSpecification, PromoteIdSpecification} from '../style-spec/types.g';
import type {MapSourceDataType} from '../ui/events';

export type CustomVectorTileSourceOptions = CustomVectorTileSourceSpecification & {
    workerOptions?: any;
    collectResourceTiming: boolean;
}

let planet = null

export function setPlanetVectorTilePlugin(planetNode) {
    planet = planetNode
}

class CustomVectorTileSource extends Evented implements Source {
    type: 'custom';
    id: string;
    minzoom: number;
    maxzoom: number;
    tileSize: number;
    attribution: string;
    promoteId: PromoteIdSpecification;

    isTileClipped: boolean;
    reparseOverscaled: boolean;
    _data: GeoJSON.GeoJSON | string;
    _options: any;
    workerOptions: any;
    map: Map;
    actor: Actor;
    _pendingLoads: number;
    _collectResourceTiming: boolean;
    _removed: boolean;

    /**
     * @private
     */
    constructor(id: string, options: CustomVectorTileSourceOptions, dispatcher: Dispatcher, eventedParent: Evented) {

        if (!planet) {
            console.error('planet-node is missing')
        }

        super();

        this.id = id;

        this.type = 'custom';

        this.minzoom = 0;
        this.maxzoom = 18;
        this.tileSize = 512;
        this.isTileClipped = true;
        this.reparseOverscaled = true;
        this._removed = false;
        this._pendingLoads = 0;

        this.actor = dispatcher.getActor();
        this.setEventedParent(eventedParent);

        this._data = (options.data as any);
        this._options = extend({}, options);

        this._collectResourceTiming = options.collectResourceTiming;

        if (options.maxzoom !== undefined) this.maxzoom = options.maxzoom;
        if (options.type) this.type = options.type;
        if (options.attribution) this.attribution = options.attribution;
        this.promoteId = options.promoteId;

        const scale = EXTENT / this.tileSize;

        // sent to the worker, along with `url: ...` or `data: literal geojson`,
        // so that it can load/parse/index the geojson data
        // extending with `options.workerOptions` helps to make it easy for
        // third-party sources to hack/reuse GeoJSONSource.
        this.workerOptions = extend({
            source: this.id,
            geojsonVtOptions: {
                buffer: (options.buffer !== undefined ? options.buffer : 128) * scale,
                tolerance: (options.tolerance !== undefined ? options.tolerance : 0.375) * scale,
                extent: EXTENT,
                maxZoom: this.maxzoom,
                lineMetrics: options.lineMetrics || false,
                generateId: options.generateId || false
            }
        }, options.workerOptions);
    }

    load() {
        // although GeoJSON sources contain no metadata, we fire this event to let the SourceCache
        // know its ok to start requesting tiles.
        this._updateWorkerData('metadata');
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    /**
     * Sets the GeoJSON data and re-renders the map.
     *
     * @param {Object|string} data A GeoJSON data object or a URL to one. The latter is preferable in the case of large GeoJSON files.
     * @returns {GeoJSONSource} this
     */
    setData(data: GeoJSON.GeoJSON | string) {
        this._data = data;
        this._updateWorkerData('content');

        return this;
    }

    /*
     * TODO: Do something similar, but instead just give a list of tiles to refetch.
     */
    _updateWorkerData(sourceDataType: MapSourceDataType) {
        const options = extend({}, this.workerOptions);
        const data = this._data;
        if (typeof data === 'string') {
            options.request = this.map._requestManager.transformRequest(browser.resolveURL(data), ResourceType.Source);
            options.request.collectResourceTiming = this._collectResourceTiming;
        } else {
            options.data = JSON.stringify(data);
        }

        this._pendingLoads++;
        this.fire(new Event('dataloading', {dataType: 'source'}));

        this.actor.send(`${this.type}.loadData`, options, (err, result) => {
            this._pendingLoads--;

            if (this._removed || (result && result.abandoned)) {
                this.fire(new Event('dataabort', {dataType: 'source', sourceDataType}));
                return;
            }

            let resourceTiming = null;
            if (result && result.resourceTiming && result.resourceTiming[this.id])
                resourceTiming = result.resourceTiming[this.id].slice(0);

            if (err) {
                this.fire(new ErrorEvent(err));
                return;
            }

            const data: any = {dataType: 'source', sourceDataType};
            if (this._collectResourceTiming && resourceTiming && resourceTiming.length > 0)
                extend(data, {resourceTiming});

            this.fire(new Event('data', data));
        });
    }

    loaded(): boolean {
        return this._pendingLoads === 0;
    }

    // called by SourceCache _loadTile
    loadTile(tile: Tile, callback: Callback<void>) {
        const message = !tile.actor ? 'loadTile' : 'reloadTile';
        tile.actor = this.actor;
        const params = {
            type: this.type,
            uid: tile.uid,
            tileID: tile.tileID,
            zoom: tile.tileID.overscaledZ,
            maxZoom: this.maxzoom,
            tileSize: this.tileSize,
            source: this.id,
            pixelRatio: this.map.getPixelRatio(),
            showCollisionBoxes: this.map.showCollisionBoxes,
            promoteId: this.promoteId
        };

        // Ok, here is where we definitely need to talk to planet-node via NodeJS
        if (planet) {
            const { z, x, y } = tile.tileID.canonical
            const res = planet.getTile(z, x, y)
            console.log('res', res)
        } 
        // else {
        //     console.log('planet-node missing')
        //     debugger
        // }

        tile.request = this.actor.send(message, params, (err, data) => {
            delete tile.request;
            tile.unloadVectorData();

            if (tile.aborted) {
                return callback(null);
            }

            if (err) {
                return callback(err);
            }

            tile.loadVectorData(data, this.map.painter, message === 'reloadTile');

            return callback(null);
        });
    }

    abortTile(tile: Tile) {
        if (tile.request) {
            tile.request.cancel();
            delete tile.request;
        }
        tile.aborted = true;
    }

    unloadTile(tile: Tile) {
        tile.unloadVectorData();
        this.actor.send('removeTile', {uid: tile.uid, type: this.type, source: this.id});
    }

    onRemove() {
        this._removed = true;
        this.actor.send('removeSource', {type: this.type, source: this.id});
    }

    serialize() {
        return extend({}, this._options, {
            type: this.type,
            data: this._data
        });
    }

    hasTransition() {
        return false;
    }
}

export default CustomVectorTileSource;
