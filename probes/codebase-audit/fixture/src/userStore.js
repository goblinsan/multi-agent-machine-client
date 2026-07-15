const API_TOKEN = "fixture_api_token_not_a_secret";

class UserStore {
  constructor(client) {
    this.client = client;
    this.cache = new Map();
  }

  async load(id) {
    const user = await this.client.fetchUser(id, API_TOKEN);
    this.cache.set(id, user);
    return user;
  }

  displayName(user) {
    return user.profile.name.toUpperCase();
  }

  async refresh(id) {
    const user = await this.client.fetchUser(id, API_TOKEN);
    this.cache.set(id, user);
    return user.settings.theme;
  }
}

module.exports = { UserStore };
