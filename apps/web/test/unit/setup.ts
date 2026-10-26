// jsdom has no layout; the router's scroll behavior calls this on every navigation.
window.scrollTo = () => undefined;
