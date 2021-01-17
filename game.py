from config import *

class Game():
    def __init__(self):
        self.white_to_move = True
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
        

    def iter_squares(self):
        for row in range(8):
            for col in range(8):
                yield ((row,col), self.layout[row][col])

    def get_piece(self, pos):
        row, col = pos
        return self.layout[row][col]

    def handle_click(self, pos):
        if self.piece_in_hand:
            self.place_piece(self.piece_in_hand, pos)
        else:
            if self.get_piece(pos) != EMPTY:
                self.pickup_piece(pos)

    def place_piece(self, piece, pos):
        row, col = pos
        self.layout[row][col] = piece
        self.piece_in_hand = None

    def remove_piece(self, pos):
        row, col = pos
        self.layout[row][col] = EMPTY

    def pickup_piece(self, pos):
        row, col = pos
        self.piece_in_hand = self.get_piece(pos)
        self.remove_piece(pos)
    
    
