/*
  DotLayer Efrem Rensi, 2017,
  based on L.CanvasLayer by Stanislav Sumbera,  2016 , sumbera.com
  license MIT
*/

// -- L.DomUtil.setTransform from leaflet 1.0.0 to work on 0.0.7
//------------------------------------------------------------------------------
L.DomUtil.setTransform = L.DomUtil.setTransform || function (el, offset, scale) {
    var pos = offset || new L.Point(0, 0);

    el.style[L.DomUtil.TRANSFORM] =
        (L.Browser.ie3d ?
            'translate(' + pos.x + 'px,' + pos.y + 'px)' :
            'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)') +
        (scale ? ' scale(' + scale + ')' : '');
};

// -- support for both  0.0.7 and 1.0.0 rc2 leaflet
L.DotLayer = (L.Layer ? L.Layer : L.Class).extend({

    _pane: "shadowPane",
    DCONST: 0.000001,
    two_pi: 2 * Math.PI,
    target_fps: 16,
    smoothFactor: 1.0,
    K: 1500000,
    S: 0.8,

    options: {
        startPaused: false,
        normal: {
            dotColor: "#000000",
            dotSize: 3
        },
        selected: {
            dotColor: "#FFFFFF",
            dotSize: 3
        }
    },

    // -- initialized is called on prototype
    initialize: function (items, options) {
        this._map    = null;
        this._canvas = null;
        this._ctx = null;
        this._frame  = null;
        this._items = items || null;
        this._timeOffset = 0;
        this._colorPalette = [];
        L.setOptions(this, options);
        this._paused = this.options.startPaused;
    },


    //-------------------------------------------------------------
    _onLayerDidResize: function (resizeEvent) {
        this._canvas.width = resizeEvent.newSize.x;
        this._canvas.height = resizeEvent.newSize.y;
        this._setupWindow();
    },

    //-------------------------------------------------------------
    _onLayerDidMove: function () {
        this._mapMoving = false;

        this._setupWindow();
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        let topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
        if (!this._paused) {
            this.animate();
        } else {
            this._frame = L.Util.requestAnimFrame(this.drawLayer, this);
        }

    },

    //-------------------------------------------------------------
    getEvents: function () {
        var events = {
            movestart: function() {
              this._mapMoving = true;
            },
            moveend: this._onLayerDidMove,
            resize: this._onLayerDidResize,
        };

        if (this._map.options.zoomAnimation && L.Browser.any3d) {
            events.zoomanim =  this._animateZoom;
        }

        return events;
    },


    //-------------------------------------------------------------
    onAdd: function (map) {
        this._map = map;
        this._canvas = L.DomUtil.create('canvas', 'leaflet-layer');
        this.tiles = {};

        let size = this._map.getSize();
        this._canvas.width = size.x;
        this._canvas.height = size.y;
        this._ctx = this._canvas.getContext('2d');

        let zoomAnimated = this._map.options.zoomAnimation && L.Browser.any3d;
        L.DomUtil.addClass(this._canvas, 'leaflet-zoom-' + (zoomAnimated ? 'animated' : 'hide'));


        // map._panes.overlayPane.appendChild(this._canvas);
        map._panes.shadowPane.style.pointerEvents = "none";
        map._panes.shadowPane.appendChild(this._canvas);

        map.on(this.getEvents(),this);


        if (this._items) {

            // set dotColors for these items
            // let itemsList = Object.values(this._items),
            //     numItems = itemsList.length;

            // this._colorPalette = createPalette(numItems);
            // for (let i=0; i<numItems; i++) {
            //     itemsList[i].dotColor = this._colorPalette[i];
            // }

            this._onLayerDidMove();
        }
    },

    //-------------------------------------------------------------
    onRemove: function (map) {
        this.onLayerWillUnmount && this.onLayerWillUnmount(); // -- callback


        // map.getPanes().overlayPane.removeChild(this._canvas);
        map.getPanes().shadowPane.removeChild(this._canvas);

        map.off(this.getEvents(),this);

        this._canvas = null;
    },


    // --------------------------------------------------------------------
    addTo: function (map) {
        map.addLayer(this);
        return this;
    },

    // --------------------------------------------------------------------
    LatLonToMercator: function (latlon) {
        return {
            x: latlon.lng * 6378137 * Math.PI / 180,
            y: Math.log(Math.tan((90 + latlon.lat) * Math.PI / 360)) * 6378137
        };
    },


    // -------------------------------------------------------------------
    _setupWindow: function () {
        if (!this._map || !this._items) {
            return;
        }

        const t0 = performance.now();

        this._size = this._map.getSize();
        this._latLngBounds = this._map.getBounds();
        this._zoom = this._map.getZoom();
        this._mapPanePos = this._map._getMapPanePos();
        this._pxOrigin = this._map.getPixelOrigin();
        this._pxBounds = this._map.getPixelBounds();
        // this._layerBounds = this._map._latLngBoundsToNewLayerBounds(this._latLngBounds, this._zoom, this._map.getCenter());

        this._pxOffset = this._mapPanePos.subtract(this._pxOrigin)._add(new L.Point(0.5, 0.5));

        const z = this._zoom,
              ppos = this._mapPanePos,
              pxOrigin = this._pxOrigin,
              pxBounds = this._pxBounds,
              layerBounds = this._layerBounds;

        // console.log(`zoom=${z}\nmapPanePos=${ppos}\nsize=${this._size}\n` +
        //             `pxOrigin=${pxOrigin}\npxBounds=[${pxBounds.min}, ${pxBounds.max}]\n` +
        //             `layerBounds=[${layerBounds.min}, ${layerBounds.max}]`);
        this._dotSize = Math.log(z);
        this._dotOffset = ~~(this._dotSize / 2 + 0.5);

        // compute relevant container points and slopes
        this._processedItems = {};
        let cp, cpp, contained;

        for (let id in this._items) {
            let A = this._items[id];
            if (!A.projected) {
                A.projected = {};
            }

            if (("latlng" in A) && this._latLngBounds.overlaps(A.bounds) && ("time" in A)) {
                let projected = A.projected[z];

                if (!projected) {
                    projected = A.latlng.map(function(latLng, i){
                        p = this._map.project(latLng);
                        p.t = A.time[i];
                        return p;
                    }.bind(this));

                    projected = L.LineUtil.simplify(projected, this.smoothFactor);
                    A.projected[z] = projected;
                }

                contained = projected.map( function (p) {
                    return this._pxBounds.contains(p);
                }.bind(this));


                cp = [];

                for (let p1, p2, i=1, len=projected.length; i<len; i++) {
                    if (contained[i-1] || contained[i]) {
                        p1 = projected[i-1];
                        if (!p1.dx) {
                            p2 = projected[i];
                            dt = p2.t - p1.t;
                            Object.assign(p1, { dx: (p2.x-p1.x)/dt, dy: (p2.y-p1.y)/dt, t2: p2.t });
                        }
                        cp.push(p1);
                    }
                }
                if (cp.length > 1) {
                    this._processedItems[id] = {
                        cp: cp,

                        // interval T between dots is a function of total distance, total time, and zoom
                        T: ~~(this.K * A.time.slice(-1) / (A.total_distance * (1 << (this._zoom-2)))),

                        // time scaling factor
                        S: this.S * Math.log(this._zoom) / (1 << (this._zoom/2)),

                        startTime: new Date(A.ts_UTC || A.beginTimestamp).getTime(),
                        totSec: A.time.slice(-1)
                    };
                }
            }
        }

        elapsed = (performance.now() - t0).toFixed(2);
        console.log(`dot context update took ${elapsed} ms`);
    },

    // --------------------------------------------------------------------
    drawDots: function(obj, now, highlighted) {
        var P = obj.cp,
            lenP = P.length,
            totSec = obj.totSec,
            T = obj.T,
            s = (now - obj.startTime) * obj.S,
            xmax = this._size.x,
            ymax = this._size.y,
            ctx = this._ctx,
            dotSize = this._dotSize,
            dotOffset = this._dotOffset,
            two_pi = this.two_pi,
            xOffset = this._pxOffset.x,
            yOffset = this._pxOffset.y;


        var key_time = s % T,
            count = 0,
            i = 0,
            t, dt,
            p = P[0],
            lx, ly;

        if (key_time < 0) {
            key_time += T;
        }

        // console.log("\nnew obj");
        // let out;

        for (t = key_time; t < totSec; t += T) {
            // out = 0;
            while (t >= p.t2) {
                i++;
                p = P[i];
                if (i >= lenP) return count;
            }

            dt = t - p.t;
            if (dt > 0) {
                lx = ~~(p.x + p.dx*dt + xOffset);
                ly = ~~(p.y + p.dy*dt + yOffset);

                if ((lx >= 0 && lx <= xmax) && (ly >= 0 && ly <= ymax)) {
                    // out = 1;
                    if (highlighted) {
                        ctx.beginPath();
                        ctx.arc(lx, ly, dotSize, 0, two_pi);
                        ctx.fill();
                        ctx.closePath();
                    } else {
                        ctx.fillRect(lx-dotOffset, ly-dotOffset, dotSize, dotSize);

                    }
                    count++;
                }
            // console.log(`t: ${t}, i: ${i}, out: ${out}`);
            }
        }
        return count;
    },

    drawLayer: function(now) {
        if (!this._map){
            return;
        }

        let ctx = this._ctx,
            zoom = this._zoom,
            count = 0,
            t0 = performance.now();

        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        this._ctx.fillStyle = this.options.normal.dotColor;

        let id,
            item,
            items = this._items,
            pItem,
            pItems = this._processedItems,
            highlighted_items = [];

        for (id in pItems) {
            item = pItems[id];
            if (items[id].highlighted) {
                highlighted_items.push(item);
            } else {
                count += this.drawDots(item, now, false);
            }
        }

        // now plot highlighted paths
        let i,
            hlen = highlighted_items.length;
        if (hlen) {
            for (i=0; i < hlen; i++) {
                item = highlighted_items[i];
                ctx.fillStyle = item.dotColor || this.options.selected.dotColor;
                count += this.drawDots(item, now, true);
            }
        }

        let elapsed = (performance.now() - t0).toFixed(1);
        fps_display && fps_display.update(now, `${elapsed} ms/f, n=${count}, z=${this._zoom}`);
    },

    // --------------------------------------------------------------------
    animate: function() {
        this._paused = false;
        this.lastCalledTime = 0;
        this.minDelay = ~~(1000/this.target_fps + 0.5);
        this._frame = L.Util.requestAnimFrame(this._animate, this);
    },

    // --------------------------------------------------------------------
    pause: function() {
        this._paused = true;
    },


    // --------------------------------------------------------------------
    _animate: function() {
        if (this._paused || this._mapMoving) {
            // Ths is so we can start where we left off when we resume
            this._timePaused = Date.now();
            return;
        }

         if (this._timePaused) {
            this._timeOffset = Date.now() - this._timePaused;
            this._timePaused = null;
        }


        let now = Date.now() - this._timeOffset;
        if (now - this.lastCalledTime > this.minDelay) {
            this.lastCalledTime = now;
            this.drawLayer(now);
        }

        this._frame = null;

        this._frame = this._frame || L.Util.requestAnimFrame(this._animate, this);
    },


    // -- L.DomUtil.setTransform from leaflet 1.0.0 to work on 0.0.7
    //------------------------------------------------------------------------------
    _setTransform: function (el, offset, scale) {
        var pos = offset || new L.Point(0, 0);

        el.style[L.DomUtil.TRANSFORM] =
            (L.Browser.ie3d ?
              'translate(' + pos.x + 'px,' + pos.y + 'px)' :
              'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)') +
            (scale ? ' scale(' + scale + ')' : '');
    },

    //------------------------------------------------------------------------------
    _animateZoom: function (e) {
        var scale = this._map.getZoomScale(e.zoom);

        // -- different calc of offset in leaflet 1.0.0 and 0.0.7 thanks for 1.0.0-rc2 calc @jduggan1
        var offset = L.Layer ? this._map._latLngToNewLayerPoint(this._map.getBounds().getNorthWest(), e.zoom, e.center) :
                               this._map._getCenterOffset(e.center)._multiplyBy(-scale).subtract(this._map._getMapPanePos());

        L.DomUtil.setTransform(this._canvas, offset, scale);
    }
});

L.dotLayer = function (items, options) {
    return new L.DotLayer(items, options);
};




/* From http://stackoverflow.com/a/20591891/4718949 */
function hslToRgbString(h,s,l) {
    return 'hsl(' + h +',' + s + '%,' + l +'% )';
}

function createPalette (colorCount) {
    let newPalette = [],
        hueStep = Math.floor ( 330 / colorCount ),
        hue = 0,
        saturation = 95,
        luminosity =  55,
        greenJump  = false;

  for ( let colorIndex=0; colorIndex < colorCount; colorIndex++ ) {
    saturation = (colorIndex & 1) ? 90 : 65;
    luminosity = (colorIndex & 1) ? 80 : 55;
    newPalette.push( hslToRgbString (hue ,saturation, luminosity ));
    hue += hueStep ;
    if (!greenJump && hue >100) {
      hue+=30;
      greenJump = true;
    }
  }
  return newPalette ;
}
