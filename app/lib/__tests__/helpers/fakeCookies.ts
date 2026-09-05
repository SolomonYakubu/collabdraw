/**
 * A `next/headers` stand-in, so a route can be given a device cookie.
 *
 * `cookies()` throws outside a request scope, and the device id is what every
 * ownership decision in the board routes turns on, so it is the one piece of
 * request context worth faking rather than working around.
 */
const DEVICE_COOKIE = "cd_device";

/** The device the request is coming from; "" is a visitor with no cookie. */
let deviceId = "device-a";

export const setDeviceId = (value: string) => {
  deviceId = value;
};

export const reset = () => {
  deviceId = "device-a";
};

export const cookies = async () => ({
  get: (name: string) =>
    name === DEVICE_COOKIE && deviceId ? { name, value: deviceId } : undefined,
});
