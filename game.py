from config import *
import random

class Game():

    def __init__(self):
        self.white_to_move = True
        self.turn = "White"
        self.waiting = "Black"
        self.piece_in_hand = None
        self.layout = [
        ["r","n","b","q","k","b","n","r"],
        ["p","p","p","p","p","p","p","p"],
        ["-","-","-","-","-","-","-","-"],
        ["-","-","-","-","-","-","-","-"],
        ["-","-","-","-","-","-","-","-"],
        ["-","-","-","-","-","-","-","-"],
        ["P","P","P","P","P","P","P","P"],
        ["R","N","B","Q","K","B","N","R"]]

    def change_turns(self):
        temp = self.turn
        self.turn = self.waiting
        self.waiting = temp
        self.white_to_move = not self.white_to_move
            
    def iter_squares(self): #returns each position tuple and piece string
        for row in range(8):
            for col in range(8):
                yield (row, col, self.layout[row][col])

    def iter_players_pieces(self, player):
        for row in range(8):
            for col in range(8):
                piece = get_piece_at((row,col))
                if piece in get_player_set(player):
                    yield ((row,col), piece)

    def list_players_pieces(self, player):
        player_set = get_player_set(player)
        pieces = []
        for pos in iter_squares():
                piece = get_piece_at(pos)
                if piece in player_set:
                    pieces.append(piece)
        return pieces

    def iter_squares(self):
        for row in range(8):
            for col in range(8):
                yield (row,col)

    def get_player_set(self, player):
        if player == "White": return ["K","Q","R","B","N","P"]
        if player == "Black": return ["k","q","r","b","n","p"]
        raise Exception(f"Unknown Player: {player}")
        
    def get_piece_at(self, pos):
        row, col = pos
        return self.layout[row][col]

    def handle_click(self, pos):
        if self.piece_in_hand:
            self.place_piece(self.piece_in_hand, pos)
        else:
            if self.get_piece_at(pos) != EMPTY:
                self.pickup_piece(pos)

    def place_piece(self, piece, pos):
        row, col = pos
        if SOUNDS_ON: SOUND_RELOAD.play()
        self.layout[row][col] = piece
        self.piece_in_hand = None

    def remove_piece(self, pos):
        row, col = pos
        self.layout[row][col] = EMPTY

    def pickup_piece(self, pos):
        row, col = pos
        self.piece_in_hand = self.get_piece_at(pos)
        self.remove_piece(pos)

    def check_for_check(self):
        if self.white_to_move:
            pos = get_pos_of("K")
            if is_threatening("Black", pos):return True
        else:
            if is_threatening("White", pos):return True
        return False

    def find_pos(self, piece):
        positions = []
        for p in self.iter_squares():
            if p[1] == piece: postions.append(p[0])
        return positions
    
    def is_threatening(self, player, pos): #If player, ie. White is threatening a specific position
        for p in self.iter_players_pieces(player):
            if pos in get_available_moves(p):
                return True
        return False

    def move(self, pos1, pos2):
        piece = get_piece_at(pos1)
        if pos2 in get_available_moves(pos1,piece):
            self.pickup_piece(pos1)
            self.place_piece(self.piece_in_hand, pos2)
        else:
            print("ILLEGAL MOVE")
            raise("ILLEGAL MOVE")
    
    def available_moves(self):
        moves = []
        for piece in iter_players_pieces(self.turn):
            moves.append(available_moves, piece)

    def available_moves(self, piece):
        pos = piece[0]
        piece_type = piece[1]
        
    def random_move(self, player):
        piece = random.choice(self.list_players_pieces(player))
        moves = self.get_available_moves(piece)

    def undo(self):
        print("Need to implement undo")
    