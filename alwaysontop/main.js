const os = require('os');
const electron = require('electron');
const robot = require("robotjs");
const { BrowserWindow, ipcMain } = electron;
const { SIZE } = require('./constants');

/**
 * The aspect ratio to preserve during AOT window resize
 * @type {number}
 */
const ASPECT_RATIO = 16 / 9;

/**
 * The coordinates(x and y) of the always on top window.
 *
 * @type {{x: number, y: number}}
 */
let position = {};

/**
 * Stores the current size of the AOT during the conference
 * @type {{width: number, height: number}}
 */
let size = Object.assign({}, SIZE);

/**
 * Keeps the old size of the window between resize handler calls
 */
let oldSize;

/**
 * Handles new-window events for the main process in order to customize the
 * BrowserWindow options of the always on top window. This handler will be
 * executed in the context of the main process.
 *
 * @param {BrowserWindow} jitsiMeetWindow - the BrowserWindow object which
 * displays Jitsi Meet.
 *
 * NOTE: All other parameters are standard for electron webcontent's new-window
 * event listeners.
 * @see {@link https://github.com/electron/electron/blob/master/docs/api/web-contents.md#event-new-window}
 */
function onAlwaysOnTopWindow(
        jitsiMeetWindow,
        event,
        url,
        frameName,
        disposition,
        options) {
    if (frameName === 'AlwaysOnTop') {
        event.preventDefault();
        const win = event.newGuest = new BrowserWindow(
            Object.assign(options, {
                backgroundColor: 'transparent',
                minWidth: SIZE.width,
                minHeight: SIZE.height,
                minimizable: false,
                maximizable: false,
                resizable: true,
                alwaysOnTop: true,
                fullscreen: false,
                fullscreenable: false,
                skipTaskbar: true,
                titleBarStyle: undefined,
                frame: false,
                show: false
            }, getPosition(), getSize())
        );
        win.once('ready-to-show', () => {
            if (win && !win.isDestroyed()) {
                win.showInactive();
            }
        });

        setAspectRatioToResizeableWindow(win, ASPECT_RATIO);

        jitsiMeetWindow.webContents.send('jitsi-always-on-top', {
            type: 'event',
            data: {
                id: win.id,
                name: 'new-window'
            }
        });
    }
}

/**
 * Calculates the coordinates for a window (based on its current coordinates and
 * size) to place it in the boundaries of a given screen.
 *
 * @param {Rectangle} windowRectangle - The current position and dimensions of
 * the window.
 * @param {Rectangle} screenRectangle - The position and dimensions of the
 * screen.
 * @returns {Point} - The new coordinates for the window.
 *
 * NOTE: All x and y coordinates are representing the top-left corner of the
 * window or screen.
 */
function positionWindowWithinScreenBoundaries(
        windowRectangle,
        screenRectangle) {
    // The min value for y coordinate of the window in order to place it within
    // the boundaries of the screen. This will be the use case where the top
    // edge of the window is exactly on the top boundary of the screen.
    const minY = screenRectangle.y;

    // The min value for x coordinate of the window in order to place it within
    // the boundaries of the screen. This will be the use case where the left
    // edge of the window is exactly on the left boundary of the screen.
    const minX = screenRectangle.x;

    // The max value for y coordinate of the window in order to place it within
    // the boundaries of the screen. This will be the use case where the bottom
    // edge of the window is exactly on the bottom boundary of the screen.
    const maxY
        = screenRectangle.y + screenRectangle.height - windowRectangle.height;

    // The max value for x coordinate of the window in order to place it within
    // the boundaries of the screen. This will be the use case where the right
    // edge of the window is exactly on the right boundary of the screen.
    const maxX
        = screenRectangle.x + screenRectangle.width - windowRectangle.width;

    return {
        x: Math.min(Math.max(windowRectangle.x, minX), maxX),
        y: Math.min(Math.max(windowRectangle.y, minY), maxY)
    };
}

/**
 * Returns the stored coordinates for the always on top window of its previous
 * location or if the last location is unknown returns coordinates to display
 * the window in the top right corner of the screen.
 *
 * @returns {{x: number, y: number}}
 */
function getPosition () {
    const Screen = electron.screen;

    if (typeof position.x === 'number' && typeof position.y === 'number') {
        // Position the window within the screen boundaries. This is needed
        // only for windows. On Mac and Linux it is working as expected without
        // changing the coordinates.
        if (os.platform() === 'win32') {
            const windowRectangle = Object.assign({}, position, size);
            const matchingScreen = Screen.getDisplayMatching(windowRectangle);
            if (matchingScreen) {
                return positionWindowWithinScreenBoundaries(
                    windowRectangle,
                    matchingScreen.workArea);
            }
        }

        return position;
    }

    const {
        x,
        y,
        width
    } = Screen.getDisplayNearestPoint(Screen.getCursorScreenPoint()).workArea;

    return {
        x: x + width - size.width,
        y
    };
}

/**
 * Gets the size to be set to the new AOT window.
 * This is used in order to preserve the size on close and open of AOT during the same meeting
 * @returns {{width: number, height: number}}
 */
function getSize () {
    if (typeof size.width === 'number' && typeof size.height === 'number') {
        return size;
    }

    return SIZE;
}

/**
 * Changes the window resize functionality to respect the passed aspect ratio.
 *
 * @param {BrowserWindow} win - The target window.
 * @param {number} aspectRatio - The aspect ratio to be set.
 * @returns {void}
 */
function setAspectRatioToResizeableWindow(win, aspectRatio) {
    //for macOS we use the built-in setAspectRatio on resize, for other we use custom implementation
    if (os.type() === 'Darwin') {
        win.setAspectRatio(aspectRatio);
        win.on('resize', () => {
            const [ width, height ] = win.getSize();
            size.width = width;
            size.height = height;
        });
    } else {
        win.on('will-resize', (e, newBounds) => {
            oldSize = win.getSize();
            const mousePos = robot.getMousePos();
            const windowBottomRightPos = {
                x: newBounds.x + newBounds.width - 16,
                y: newBounds.y + newBounds.height - 16,
            };
            //prevent resize from bottom right corner as it is buggy.
            if (mousePos.x >= windowBottomRightPos.x && mousePos.y >= windowBottomRightPos.y) {
                e.preventDefault();
            }
        });
        win.on('resize', () => {
            let [ width, height ] = win.getSize();

            //we scale either width or height according to the other by checking which of the 2
            //changed the most since last resize.
            if (Math.abs(oldSize[0] - width) >= Math.abs(oldSize[1] - height)) {
                height = Math.round(width / aspectRatio);
            } else {
                width = Math.round(height * aspectRatio);
            }
            win.setSize(width, height);
            size.width = width;
            size.height = height;
        });
    }
}

/**
 * Initializes the always on top functionality in the main electron process.
 *
 * @param {BrowserWindow} jitsiMeetWindow - the BrowserWindow object which
 * displays Jitsi Meet
 */
module.exports = function setupAlwaysOnTopMain(jitsiMeetWindow) {
    ipcMain.on('jitsi-always-on-top', (event, { type, data = {} }) => {
        if (type === 'event' && data.name === 'position') {
            const { x, y } = data;

            position = {
                x,
                y
            };
        }

        if (type === 'event' && data.name === 'resetSize') {
            size = Object.assign({}, SIZE);
        }
    });

    jitsiMeetWindow.webContents.on(
        'new-window',
        (...args) => {
            onAlwaysOnTopWindow(jitsiMeetWindow, ...args);
        }
    );
};
