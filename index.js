'use strict';
const Path = require('path');
const Fs = require('fs');
const Crypto = require('crypto');
const streamifier = require('streamifier');
const toArray = require('stream-to-array');
const tar = require('tar-stream');
const request = require('request');
const requestp = require('request-promise');
const nodeUUID = require('node-uuid');
const config = require(Path.join(__dirname, 'config'));

const logger = require('winston');
logger.remove(logger.transports.Console);
logger.add(logger.transports.Console, {
  level: config.logs.console_level ? config.logs.console_level: 'info',
  colorize: true,
  timestamp: true,
})

if (config.logs.file)
  logger.add(logger.transports.File, {
    level: config.logs.file_level ? config.logs.file_level : 'error',
    filename: config.logs.file,
  });

logger.info('Welcome to uLinux Device Updater Daemon, ' +
  'we hope you have a productive day! :) ');
if (config.logs.file) logger.info('Logging to file: %s', config.logs.file);

// Take care of generating uuid
let uuid;
try {
  uuid = Fs.readFileSync(
    Path.join(config.image_path, '..', 'uuid'),  { encoding: 'UTF-8' }
  );
} catch (error) {
  // File does not exist, generate
  uuid = nodeUUID.v4();
  Fs.writeFileSync(
    Path.join(config.image_path, '..', 'uuid'), uuid, { encoding: 'UTF-8' }
  );
}

let cert, key;

try {
  cert = Fs.readFileSync(Path.resolve(__dirname, config.cert_path));
  key = Fs.readFileSync(Path.resolve(__dirname, config.key_path));
} catch (err) {
  // generate certs and keys
  const exec = require('child_process').execSync;
  exec('sh ' + __dirname + '/gen_certs.sh');
  cert = Fs.readFileSync(Path.resolve(__dirname, config.cert_path));
  key = Fs.readFileSync(Path.resolve(__dirname, config.key_path));
}

const ca = Fs.readFileSync(Path.resolve(__dirname, config.update_server_ca_cert));
const signing_key = Fs.readFileSync(Path.resolve(__dirname, config.signing_server_pubkey));

const sendImAlive = require('./imalive')(config, logger, uuid);

function checkForUpdates () {
  logger.info('uLinux Device Updater Daemon: Checking for updates');
  return new Promise((resolve, reject) => {

    requestp.post({
      url: 'https://' + config.update_server + '/newUpdate',
      cert: cert,
      key: key,
      ca: ca,
      form: {
        timestamp: getLatestUpdateTimestamp(),
      },
      json: true
    }).then((res) => {
      if (res.message) {
        resolve(res.updateId);
      } else {
        reject('No new update found!');
      }
    }).catch((err) => {
      const wrapper = new Error('Got an error checking for updates');
      wrapper.cause = err;
      reject(wrapper);
    });

  });
}

function getLatestUpdateTimestamp() {
  let timestamp;

  try {
    timestamp = parseInt(Fs.readFileSync(
      Path.join(config.image_path, '..', 'last_update'),  { encoding: 'UTF-8' }
    ));
  } catch (error) {
    // File does not exist (never updated before), use UNIX epoch
    timestamp = 0;
  }

  return timestamp;
}

function downloadImage (updateId) {
  logger.info('uLinux Device Updater Daemon: Downloading update with id ' + updateId);
  Fs.writeFileSync(
    Path.join(config.image_path, '..', 'firmware_version'),
    updateId,
    { encoding: 'UTF-8' }
  );
  return new Promise((resolve, reject) => {

    request.get({
      url: 'https://' + config.update_server + '/updates/' + updateId,
      cert: cert,
      key: key,
      ca: ca,
      encoding: null,
    }, (err, response, body) => {
      if (err) {
        const wrapper = new Error('Got an error retrieving the update image.');
        wrapper.cause = err;
        reject(wrapper);
      }
      else if (response.headers['content-type'].indexOf('application/json') != -1) {
        // Some error message
        const wrapper = new Error('Got an error retrieving the update image.');
        try {
          wrapper.cause = JSON.parse(new String(body, 'UTF-8'));
        } catch (e) {
          wrapper.cause =
            new Error('Could not parse error message produced by the API');
        }
        reject(wrapper);
      } else {
        // We're actually getting the file
        resolve(body);
      }
    });
  });
}

function verifyImage (buffer) {
  logger.debug('uLinux Device Updater Daemon: Verifying image');
  const pack = streamifier.createReadStream(buffer);
  const extract = tar.extract();

  let image, signature;

  return new Promise((resolve, reject) => {
    extract.on('entry', (header, stream, callback) => {
      // header is the tar header
      // stream is the content body (might be an empty stream)
      // call next when you are done with this entry

      toArray(stream)
        .then((parts) => {
          // concatenate all the array entries into the same buffer
          const buffers = [];
          for (let i = 0, l = parts.length; i < l ; ++i) {
            const part = parts[i];
            buffers.push((part instanceof Buffer) ? part : new Buffer(part));
          }

          const resBuffer = Buffer.concat(buffers);

          if (header.name === 'signature.txt') {
            signature = resBuffer.toString();
          }

          if (header.name === 'image.img') {
            image = resBuffer;
          }

          callback(); // tar-stream requires calling this to begin nexy entry
        });

    });

    const verify = Crypto.createVerify('RSA-SHA512');
    extract.on('finish', () => {
      if (!signature || !image) {
        reject(new Error('Signature or image is missing from downloaded tar file.'));
      } else {
        verify.write(image);
        verify.end();
        if(verify.verify(signing_key, signature, 'base64')){
          resolve(image);
        } else {
          reject(new Error('Image signature was not successfully verified.'));
        }
      }
    });

    pack.pipe(extract);

  });
}

function writeImageToDisk (buffer) {
  logger.debug('uLinux Device Updater Daemon: Writing image to disk');
  Fs.writeFile(config.image_path, buffer, (err) => {
    if (err) {
      logger.error('Got an error writing the image file to disk', err);
    }
  });
  // Save the timestamp for this update
  Fs.writeFile(Path.join(config.image_path, '..', 'last_update'), Math.round(Date.now()/1000), (err) => {
    if (err) {
      logger.error('Got an error writing the last update timestamp to disk',
        err);
    }
  });

}

function reboot () {
  logger.info('uLinux Device Updater Daemon: Rebooting device');
  const spawn = require('child_process').spawn;
  const reboot = spawn('reboot');
}

let working = false;

function performUpdate() {
  if (!working) {
    working = true;
    checkForUpdates()
      .then(downloadImage)
      .then(verifyImage)
      .then(writeImageToDisk)
      .then(reboot)
      .catch((err) => {
        working = false;
        logger.error('uLinux Device Updater Daemon:', err);
      });
  }
}

performUpdate();

// Update notification server
const Hapi = require('hapi');

const server = new Hapi.Server();
server.connection({
  port: config.api_port,
  tls: {
    key: Fs.readFileSync(Path.resolve(__dirname, 'server.key')),
    cert: Fs.readFileSync(Path.resolve(__dirname, 'server.crt')),
    // Authenticate update server's client cert
    ca: [
      Fs.readFileSync(config.update_server_ca_cert),
    ],
    requestCert: true,
    rejectUnauthorized: true
  }
});

server.route({
  method: 'POST',
  path: '/newUpdate',
  handler: function (request, reply) {
    let sentTimestamp = new Date(request.payload.timestamp);
    if (sentTimestamp.getTime() > getLatestUpdateTimestamp()) {
      reply();
      downloadImage(request.payload.id)
      .then(verifyImage)
      .then(writeImageToDisk)
      .then(reboot)
      .catch((err) => {
        working = false;
        logger.error('uLinux Device Updater Daemon:', err);
      });
    } else {
      logger.info('uLinux Device Updater Daemon: update server sent a old timestamp');
      logger.debug(`Sent timestamp: ${request.payload.timestamp}, current update timestamp: ${getLatestUpdateTimestamp()}`);
      reply();
    }
  }
});

function setPortMap() {
  const client = require('nnupnp').createClient();
  client.portMapping({
    description: 'uLinux Device Updater Daemon',
    public: config.api_port,
    private: config.api_port,
    ttl: 0
  }, (err) => {
    if (err) logger.error('uLinux Device Updater Daemon: failed setting upnp port map', err);
    else logger.debug('uLinux Device Updater Daemon: set upnp port map succesfully');
  });
}

server.start((err) => {
    if (err) {
        Logger.error('uLinux Device Updater Daemon: Got an error starting ' +
          ' API Server', err);
    } else {
      setPortMap();
    }
});

setInterval(sendImAlive, config.imalive_interval * 60 * 1000);
sendImAlive();
