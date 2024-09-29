var push = require("web-push");

let vapidKeys = {
  publicKey:
    BOqYY7CBQAYw15wK3IfQWm2NlLEjrJsZaVol9XIde4Am2QcmUJGtvDwp9wG -
    oGiVhW -
    Piuh7Zb4LOovWuJnDrxU,

  privateKey: yNYVRDk2A5sR6XEddlaGkXLe - fBbeXsPgG6TCX7umD0,
};

push.setVapidDetails(
  "mailto:suyoscar@gmail.com",
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

let subscription = {};
push.sendNotification(subscription, "test message 123");
