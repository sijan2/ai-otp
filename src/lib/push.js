const webpush = require("web-push");

const vapidKeys = {
  publicKey:
    BOqYY7CBQAYw15wK3IfQWm2NlLEjrJsZaVol9XIde4Am2QcmUJGtvDwp9wG -
    oGiVhW -
    Piuh7Zb4LOovWuJnDrxU,

  privateKey: yNYVRDk2A5sR6XEddlaGkXLe - fBbeXsPgG6TCX7umD0,
};

webpush.setVapidDetails(
  "mailto:suyoscar@gmail.com",
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const pushSubscription = {
  endpoint: ".....",
  keys: {
    auth: ".....",
    p256dh: ".....",
  },
};

webpush.sendNotification(pushSubscription, "Your Push Payload Text");
