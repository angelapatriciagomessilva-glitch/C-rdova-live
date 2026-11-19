var exec = require('cordova/exec');

var LiveRtmp = {
    open: function (url, key, w, h, fps, kbps, sampleRate, channels, success, error) {
        exec(success, error, 'LiveRtmp', 'open', [url, key, w, h, fps, kbps, sampleRate, channels]);
    },
    video: function (annexb, ts, key, success, error) {
        exec(success || null, error || null, 'LiveRtmp', 'video', [annexb, ts, key]);
    },
    audio: function (pcm, ts, success, error) {
        exec(success || null, error || null, 'LiveRtmp', 'audio', [pcm, ts]);
    },
    status: function (success, error) {
        exec(success, error, 'LiveRtmp', 'status', []);
    },
    close: function (success, error) {
        exec(success, error, 'LiveRtmp', 'close', []);
    }
};

module.exports = LiveRtmp;
