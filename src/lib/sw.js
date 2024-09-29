self.addEventListener("push", () => {
  self.registration.sendNotification("Hello World", {});
});
