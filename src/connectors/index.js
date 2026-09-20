import * as ebay from './ebay.js';
import * as ownSite from './ownSite.js';
import * as amazon from './amazon.js';
import * as tiktokShop from './tiktokShop.js';

export const connectors = {
  ebay,
  own_site: ownSite,
  amazon,
  tiktok_shop: tiktokShop,
};

export function activeChannels() {
  return Object.entries(connectors)
    .filter(([, connector]) => connector.isConfigured())
    .map(([channel]) => channel);
}

export function allChannelsStatus() {
  return Object.entries(connectors).map(([channel, connector]) => ({
    channel,
    configured: connector.isConfigured(),
  }));
}
