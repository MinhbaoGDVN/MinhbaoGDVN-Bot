const MAX_ACTIVITY_EVENTS = 500;
const activityEvents = [];

export function recordTicketActivity(event) {
    const entry = {
        ...event,
        at: new Date().toISOString()
    };

    activityEvents.push(entry);
    if (activityEvents.length > MAX_ACTIVITY_EVENTS) activityEvents.shift();

    return entry;
}

export function getTicketActivity() {
    return [...activityEvents].reverse();
}