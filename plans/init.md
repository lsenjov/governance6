Create a new application for playing a game online, called Governance

Each user has a display name, which can be changed at any time from a profile page.

A user can create Syndicates.
Each Syndicate has a name, leader and description.
Each Syndicate has a played boolean, default to false.
Each Syndicate has a number of drawbacks. Each drawback has a name and description.
Each Syndicate has an "is-shared" boolean, defaulting to false. If this is set to true, a users cannot modify details of the Syndicate or Minions

Each Syndicate has up to 8 Minions.
Each Minion has a name (string, mandatory), accent (optional), description (optional).
Each Minion has 1-5 skills. Each skill is a single string.

Users can create a game. The owner of a game is called a Game Master, or GM for short.
Games have a state (ready, playing, archived). All users can see the status, only the GM can change it.

Games have a start time, which is nil by default.
- The game tracks when a game is moved to "playing" status, and displays for all users how long a game has been going while it is in "playing" status.
- While the game is in "ready" status, a user can be added or removed to the game by the GM. If they are added, they are called a Player.
- While the game is in "ready" status, a Player can select which Syndicate to use
    - A Player can select any of their own created Syndicates, or any Syndicate with a set "is-shared" boolean
- When the game leaves "ready" status, all Syndicates have the "played" boolean to true.

In each game, each Player has an amount of POWER(integer). The GM can edit this at any time.
Each player has a ledger of POWER income and expenditures. Every time POWER changes, it will be logged here, with an optional reason (string).
POWER can go negative.
A Player can send a positive amount of POWER to any other Player or the bank, with a reason

In each game, a Player can see the list of their own Minions, and whether they've been "bought" or not.
A Player can buy their Minions to set them to "bought"
A Player buys their first Minion for free. After that the price rises by two each time i.e.: 2/4/6/8/10/12/14

Each game has a Call Queue.
A Player can add a bought Minion to the Call Queue.
A Player can only have one Call in the Call Queue. If one already exists, their new choice replaces the old one.
The GM can remove calls from the Call Queue.
There is a displayed history of recently removed calls (last 10 calls)
