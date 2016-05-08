const request = require('requestp');
const Fs = require('fs');

module.exports = function (config, logger, uuid) {
  const cert = Fs.readFileSync(Path.resolve(__dirname, config.cert_path));
  const key = Fs.readFileSync(Path.resolve(__dirname, config.key_path));
  const ca = Fs.readFileSync(Path.resolve(__dirname, config.update_server_ca_cert));
  const signing_key = Fs.readFileSync(Path.resolve(__dirname, config.signing_server_pubkey));

  return () => {
    request.post({
      url: `https://${config.update_server}/`,
      cert: cert,
      key: key,
      ca: ca,
      resolveWithFullResponse: true,
      form: {
        deviceId: uuid,
        firmwareVersion: Fs.readFileSync(
          Path.join(config.image_path, '..', 'firmware_version'),
          { encoding: 'UTF-8' }
        ),
        port: config.api_port
      }
    }).then((res) => {
      if (res.statusCode == 200) {
        logger.debug('uLinux Device Updater Daemon: Sent I\'m Alive message to update server.');
      } else {
        logger.error(`uLinux Device Updater Daemon: Got an unexpected status ` +
        `code while sending I\'m Alive message: ${res.statusCode}`, res);
      }
    }).catch((err) => {
      const wrapper = new Error('Got an error sending I\'m Alive');
      wrapper.cause = err;
      logger.error('uLinux Device Updater Daemon:', err);
    });
  }
}
